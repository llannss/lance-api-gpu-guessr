// ============================================
// GPU Guessr
// One page, three views (lobby, play, results). Every mode builds its rounds
// from a seeded random generator, so a "challenge a friend" link replays the
// exact same rounds. The catalog is shown as entered in the admin, odd values
// included.
// ============================================

const $ = (id) => document.getElementById(id);

const STANDARD_ROUNDS = 10;
const BLITZ_SECONDS = 60;
const BLITZ_RIGHT = 2;     // seconds added for a right answer
const BLITZ_WRONG = 5;     // seconds taken for a wrong one
const SURVIVAL_LIVES = 3;
const DAILY_TRIES = 6;
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

let catalog = [];          // every usable GPU
let favoriteIds = null;    // Set of ids, or null when favorites can't be read
let runKind = "standard";
let run = null;            // the run in progress


// ============================================
// SMALL HELPERS
// ============================================

function escapeHTML(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Seeded random numbers (mulberry32): the same seed gives the same rounds.
function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hashString(text) {
    let h = 2166136261;
    for (const ch of text) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

function shuffle(rng, list) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

// n different items from list, never `avoid`
function sample(rng, list, n, avoid = []) {
    return shuffle(rng, list.filter((x) => !avoid.includes(x))).slice(0, n);
}

function readStore(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function writeStore(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // private window or storage blocked: the game still works, it just forgets
    }
}


// ============================================
// READING THE CATALOG
// ============================================

function firstNumber(text) {
    const match = String(text ?? "").match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : NaN;
}

// "32GB GDDR7" -> 32, "512MB" -> 0.5
function vramGb(gpu) {
    const match = String(gpu.vram ?? "").match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB)?/i);
    if (!match) return NaN;
    const unit = (match[2] || "GB").toUpperCase();
    const n = Number(match[1]);
    return unit === "MB" ? n / 1024 : unit === "TB" ? n * 1024 : n;
}

// "2.41 GHz" -> 2.41, "1710 MHz" -> 1.71
function clockGhz(text) {
    const n = firstNumber(text);
    return /mhz/i.test(String(text)) ? n / 1000 : n;
}

const year = (gpu) => firstNumber(String(gpu.release_date ?? "").slice(0, 4));
const price = (gpu) => {
    const n = Number(gpu.launch_price_usd);
    return n > 0 ? n : NaN;
};
const bandwidth = (gpu) => Number(gpu.memory_bandwidth_gbps) || NaN;

const money = (n) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "price unknown");

// The picture from the catalog (Supabase), else the game's own images/ folder.
function imageFor(gpu) {
    if (typeof gpu.image_url === "string" && /^https?:\/\//.test(gpu.image_url)) return gpu.image_url;
    const slug = String(gpu.model || "gpu")
        .replace(/^(nvidia|geforce|amd|radeon|intel)\s+/i, "")
        .replace(/^(geforce|radeon)\s+/i, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    return `images/${slug}.png`;
}

const hasPicture = (gpu) => typeof gpu.image_url === "string" && /^https?:\/\//.test(gpu.image_url);

function factLine(gpu) {
    return [
        gpu.brand,
        Number.isFinite(year(gpu)) ? `released ${year(gpu)}` : "",
        gpu.vram,
        Number.isFinite(price(gpu)) ? `${money(price(gpu))} at launch` : "",
    ].filter(Boolean).join(" · ");
}

// A broken picture shows the drawn picture icon instead of a broken image.
document.addEventListener("error", (event) => {
    const img = event.target;
    if (img instanceof HTMLImageElement && !img.closest(".brand")) {
        img.hidden = true;
        img.parentElement?.classList.add("is-missing");
    }
}, true);

function setPicture(img, gpu) {
    img.hidden = false;
    img.parentElement?.classList.remove("is-missing");
    img.src = imageFor(gpu);
}


// ============================================
// LOADING
// ============================================

async function fetchCatalog() {
    const response = await fetch("/api/gpus", { cache: "no-store", credentials: "same-origin" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.error || "Couldn't load the GPU list.");
    const list = Array.isArray(data) ? data : data.gpus || data.data || [];
    return list.filter((gpu) => gpu && gpu.id != null && gpu.model);
}

// Works once the game is served under GPU Nexus (/arena) with the shared
// sign-in. On its own address the request fails and the toggle explains why.
async function fetchFavorites() {
    try {
        const response = await fetch("/api/me/favorites", { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) return null;
        const data = await response.json();
        return new Set((data.gpu_ids || []).map(String));
    } catch {
        return null;
    }
}


// ============================================
// THE MODES
// Each mode: id, name, rule (one line), picture (needs pictures), make(rng,
// pool, level) -> round, render(round, stage, answer). A round ends by calling
// answer({ right, points, gpu, status, facts }).
// ============================================

const CLASSIC_CLUES = [
    ["Power", (g) => g.power],
    ["Boost clock", (g) => g.boost_clock],
    ["Memory bandwidth", (g) => (bandwidth(g) ? `${bandwidth(g).toLocaleString()} GB/s` : "")],
    ["VRAM", (g) => g.vram],
    ["Released", (g) => (Number.isFinite(year(g)) ? String(year(g)) : "")],
    ["Architecture", (g) => g.architecture],
];

const HL_STATS = [
    { key: "vram", label: "VRAM", get: vramGb, show: (v) => `${v < 1 ? v * 1024 + "MB" : v + "GB"}` },
    { key: "bw", label: "memory bandwidth", get: bandwidth, show: (v) => `${v.toLocaleString()} GB/s` },
    { key: "clock", label: "boost clock", get: (g) => clockGhz(g.boost_clock), show: (v) => `${v.toFixed(2)} GHz` },
    { key: "power", label: "power draw", get: (g) => firstNumber(g.power), show: (v) => `${v} W` },
    { key: "price", label: "launch price", get: price, show: (v) => money(v) },
    { key: "year", label: "release year", get: year, show: (v) => String(v) },
];

// distractors get closer as Survival levels go up: same brand, then same architecture
function distractors(rng, pool, answer, level) {
    const same = (key) => pool.filter((g) => g !== answer && g[key] && g[key] === answer[key]);
    let near = [];
    if (level >= 3) near = same("architecture");
    if (near.length < 3 && level >= 2) near = same("brand");
    const picked = sample(rng, near, 3);
    return [...picked, ...sample(rng, pool, 3 - picked.length, [answer, ...picked])];
}

function optionButtons(items, label) {
    return `<div class="options">${items.map((item, i) => `
        <button class="option" type="button" data-index="${i}">
            <kbd aria-hidden="true">${i + 1}</kbd><span>${escapeHTML(label(item))}</span>
        </button>`).join("")}</div>`;
}

// Settle a multiple-choice round: mark the buttons, then report.
function settleOptions(stage, rightIndex, chosenIndex) {
    stage.querySelectorAll(".option, .lineup-pick").forEach((btn) => {
        const i = Number(btn.dataset.index);
        btn.disabled = true;
        if (i === rightIndex) btn.classList.add("is-right");
        else if (i === chosenIndex) btn.classList.add("is-wrong");
    });
}

function wireOptions(stage, onChoose) {
    stage.querySelectorAll("[data-index]").forEach((btn) => {
        btn.addEventListener("click", () => onChoose(Number(btn.dataset.index)));
    });
}

// A reveal that runs for `ms`: calls step(t) with t from 0 to 1. Under reduced
// motion it moves in four still steps instead of continuously.
function runReveal(ms, step) {
    const start = performance.now();
    let frame = 0;
    let stopped = false;
    const tick = (now) => {
        if (stopped) return;
        let t = Math.min(1, (now - start) / ms);
        if (REDUCED_MOTION) t = Math.floor(t * 4) / 4;
        step(t);
        if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return {
        elapsed: () => Math.min(1, (performance.now() - start) / ms),
        stop: () => { stopped = true; cancelAnimationFrame(frame); },
    };
}

const MODES = [
    {
        id: "classic",
        name: "Classic",
        rule: "Clues appear one at a time. Name the card early for more points.",
        make(rng, pool, level) {
            const gpu = pick(rng, pool);
            return { gpu, options: shuffle(rng, [gpu, ...distractors(rng, pool, gpu, level)]), shown: 2 };
        },
        render(round, stage, answer) {
            const clues = CLASSIC_CLUES.map(([label, get]) => [label, get(round.gpu) || "Not listed"]);
            stage.innerHTML = `
                <h2 class="stage-q">Which GPU is this?</h2>
                <dl class="clues" id="clues"></dl>
                <button class="btn btn-quiet reveal-clue" type="button" id="moreClue"></button>
                ${optionButtons(round.options, (g) => g.model)}`;
            const draw = () => {
                $("clues").innerHTML = clues.map(([label, value], i) => i < round.shown
                    ? `<div class="clue"><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`
                    : `<div class="clue is-hidden"><dt>${escapeHTML(label)}</dt><dd>Hidden</dd></div>`).join("");
                const left = clues.length - round.shown;
                $("moreClue").hidden = left === 0;
                $("moreClue").textContent = `Show another clue (−25 points, ${left} left)`;
            };
            draw();
            $("moreClue").addEventListener("click", () => { round.shown++; draw(); });
            wireOptions(stage, (i) => {
                const right = round.options[i] === round.gpu;
                settleOptions(stage, round.options.indexOf(round.gpu), i);
                const points = right ? 50 + 25 * (clues.length - round.shown) : 0;
                answer({ right, points, gpu: round.gpu });
            });
        },
    },
    {
        id: "higher-lower",
        name: "Higher or Lower",
        rule: "Two cards, one stat. Does the second one have more or less?",
        make(rng, pool, level, previous) {
            for (let tries = 0; tries < 60; tries++) {
                const stat = pick(rng, HL_STATS);
                const a = previous?.b && Number.isFinite(stat.get(previous.b)) ? previous.b : pick(rng, pool);
                const options = pool.filter((g) => g !== a && Number.isFinite(stat.get(g)) && stat.get(g) !== stat.get(a));
                if (!Number.isFinite(stat.get(a)) || !options.length) continue;
                return { stat, a, b: pick(rng, options) };
            }
            return null;
        },
        render(round, stage, answer) {
            const { stat, a, b } = round;
            stage.innerHTML = `
                <h2 class="stage-q">Does the ${escapeHTML(b.model)} have a higher or lower ${escapeHTML(stat.label)}?</h2>
                <div class="duel">
                    <article class="duel-card">
                        <div class="duel-photo"><img alt="" decoding="async"></div>
                        <h3>${escapeHTML(a.model)}</h3>
                        <p class="duel-value">${escapeHTML(stat.show(stat.get(a)))}</p>
                        <p class="duel-label">${escapeHTML(stat.label)}</p>
                    </article>
                    <span class="duel-vs" aria-hidden="true">vs</span>
                    <article class="duel-card">
                        <div class="duel-photo"><img alt="" decoding="async"></div>
                        <h3>${escapeHTML(b.model)}</h3>
                        <p class="duel-value is-hidden" id="duelHidden">?</p>
                        <p class="duel-label">${escapeHTML(stat.label)}</p>
                    </article>
                </div>
                <div class="hl-buttons">
                    <button class="btn btn-choice" type="button" data-choice="higher"><kbd aria-hidden="true">H</kbd> Higher</button>
                    <button class="btn btn-choice" type="button" data-choice="lower"><kbd aria-hidden="true">L</kbd> Lower</button>
                </div>`;
            const imgs = stage.querySelectorAll(".duel-photo img");
            setPicture(imgs[0], a);
            setPicture(imgs[1], b);
            stage.querySelectorAll("[data-choice]").forEach((btn) => btn.addEventListener("click", () => {
                const higher = stat.get(b) > stat.get(a);
                const right = (btn.dataset.choice === "higher") === higher;
                const hidden = $("duelHidden");
                hidden.textContent = stat.show(stat.get(b));
                hidden.classList.remove("is-hidden");
                stage.querySelectorAll("[data-choice]").forEach((x) => {
                    x.disabled = true;
                    if ((x.dataset.choice === "higher") === higher) x.classList.add("is-right");
                    else if (x === btn) x.classList.add("is-wrong");
                });
                answer({ right, points: right ? 50 : 0, gpu: b,
                    status: `${b.model}: ${stat.show(stat.get(b))} vs ${stat.show(stat.get(a))}` });
            }));
        },
    },
    {
        id: "year",
        name: "Year Guess",
        rule: "See the card, slide to its launch year. Closer scores more.",
        picture: true,
        make(rng, pool) {
            const dated = pool.filter((g) => Number.isFinite(year(g)));
            return { gpu: pick(rng, dated) };
        },
        render(round, stage, answer) {
            const years = catalog.map(year).filter(Number.isFinite);
            const min = Math.min(...years) - 2;
            const max = Math.max(...years) + 1;
            const middle = Math.round((min + max) / 2);
            stage.innerHTML = `
                <h2 class="stage-q">What year did this card launch?</h2>
                <div class="solo">
                    <div class="solo-photo"><img alt="" decoding="async"></div>
                    <div class="solo-side">
                        <dl class="clues is-compact">
                            <div class="clue"><dt>VRAM</dt><dd>${escapeHTML(round.gpu.vram || "Not listed")}</dd></div>
                            <div class="clue"><dt>Memory type</dt><dd>${escapeHTML(round.gpu.memory_type || "Not listed")}</dd></div>
                        </dl>
                        <label class="slider-label" for="yearSlider">Your guess <output id="yearOut">${middle}</output></label>
                        <input class="slider" type="range" id="yearSlider" min="${min}" max="${max}" step="1" value="${middle}">
                        <div class="slider-ends" aria-hidden="true"><span>${min}</span><span>${max}</span></div>
                        <button class="btn btn-primary" type="button" id="lockYear">Lock in ${middle}</button>
                    </div>
                </div>`;
            setPicture(stage.querySelector(".solo-photo img"), round.gpu);
            const slider = $("yearSlider");
            slider.addEventListener("input", () => {
                $("yearOut").textContent = slider.value;
                $("lockYear").textContent = `Lock in ${slider.value}`;
            });
            $("lockYear").addEventListener("click", () => {
                const guess = Number(slider.value);
                const off = Math.abs(guess - year(round.gpu));
                slider.disabled = true;
                $("lockYear").disabled = true;
                answer({ right: off <= 1, points: Math.max(0, 100 - 20 * off), gpu: round.gpu,
                    status: off === 0 ? `Exactly ${year(round.gpu)}.` : `You said ${guess}; it launched in ${year(round.gpu)} (${off} year${off === 1 ? "" : "s"} off).` });
            });
        },
    },
    {
        id: "zoom",
        name: "Zoom Reveal",
        rule: "Starts as an extreme close-up and pulls back. Guess before it's obvious.",
        picture: true,
        make(rng, pool, level) {
            const gpu = pick(rng, pool);
            return { gpu, options: shuffle(rng, [gpu, ...distractors(rng, pool, gpu, level)]),
                ox: 25 + Math.round(rng() * 50), oy: 25 + Math.round(rng() * 50) };
        },
        render(round, stage, answer) {
            stage.innerHTML = `
                <h2 class="stage-q">Which GPU is this?</h2>
                <div class="zoom-frame"><img alt="A close-up of the mystery card" decoding="async"></div>
                ${optionButtons(round.options, (g) => g.model)}`;
            const img = stage.querySelector(".zoom-frame img");
            setPicture(img, round.gpu);
            img.style.transformOrigin = `${round.ox}% ${round.oy}%`;
            const reveal = runReveal(12000, (t) => {
                img.style.transform = `scale(${(4 - 3 * (1 - (1 - t) ** 2)).toFixed(3)})`;
            });
            run.cleanup = reveal.stop;
            wireOptions(stage, (i) => {
                const left = 1 - reveal.elapsed();
                reveal.stop();
                img.style.transform = "scale(1)";
                const right = round.options[i] === round.gpu;
                settleOptions(stage, round.options.indexOf(round.gpu), i);
                answer({ right, points: right ? 50 + Math.round(100 * left) : 0, gpu: round.gpu });
            });
        },
    },
    {
        id: "lineup",
        name: "Blurred Lineup",
        rule: "One name, four blurred pictures. Pick the right card as they sharpen.",
        picture: true,
        make(rng, pool, level) {
            const gpu = pick(rng, pool);
            return { gpu, options: shuffle(rng, [gpu, ...distractors(rng, pool, gpu, level)]) };
        },
        render(round, stage, answer) {
            stage.innerHTML = `
                <h2 class="stage-q">Which one is the ${escapeHTML(round.gpu.model)}?</h2>
                <div class="lineup">${round.options.map((g, i) => `
                    <button class="lineup-pick" type="button" data-index="${i}" aria-label="Picture ${i + 1}">
                        <span class="lineup-photo"><img alt="" decoding="async"></span>
                        <kbd aria-hidden="true">${i + 1}</kbd>
                    </button>`).join("")}</div>`;
            const imgs = [...stage.querySelectorAll(".lineup-photo img")];
            imgs.forEach((img, i) => setPicture(img, round.options[i]));
            const reveal = runReveal(10000, (t) => {
                imgs.forEach((img) => { img.style.filter = `blur(${(18 * (1 - t)).toFixed(1)}px)`; });
            });
            run.cleanup = reveal.stop;
            wireOptions(stage, (i) => {
                const left = 1 - reveal.elapsed();
                reveal.stop();
                imgs.forEach((img, j) => {
                    img.style.filter = "none";
                    img.closest(".lineup-pick").setAttribute("aria-label", round.options[j].model);
                    img.closest(".lineup-pick").insertAdjacentHTML("beforeend",
                        `<span class="lineup-name">${escapeHTML(round.options[j].model)}</span>`);
                });
                const right = round.options[i] === round.gpu;
                settleOptions(stage, round.options.indexOf(round.gpu), i);
                answer({ right, points: right ? 50 + Math.round(100 * left) : 0, gpu: round.gpu });
            });
        },
    },
    {
        id: "price",
        name: "Price Guess",
        rule: "Slide to the launch price. Within a quarter of it counts as right.",
        picture: true,
        make(rng, pool) {
            return { gpu: pick(rng, pool.filter((g) => Number.isFinite(price(g)))) };
        },
        render(round, stage, answer) {
            // a log scale from $20 to $5,000, so cheap and flagship cards are both easy to hit
            const LOW = Math.log(20), HIGH = Math.log(5000);
            const toPrice = (v) => {
                const raw = Math.exp(LOW + (HIGH - LOW) * (v / 1000));
                return raw < 100 ? Math.round(raw) : Math.round(raw / 10) * 10;
            };
            stage.innerHTML = `
                <h2 class="stage-q">What did the ${escapeHTML(round.gpu.model)} cost at launch?</h2>
                <div class="solo">
                    <div class="solo-photo"><img alt="" decoding="async"></div>
                    <div class="solo-side">
                        <dl class="clues is-compact">
                            <div class="clue"><dt>Released</dt><dd>${escapeHTML(Number.isFinite(year(round.gpu)) ? year(round.gpu) : "Not listed")}</dd></div>
                            <div class="clue"><dt>VRAM</dt><dd>${escapeHTML(round.gpu.vram || "Not listed")}</dd></div>
                        </dl>
                        <label class="slider-label" for="priceSlider">Your guess <output id="priceOut">${money(toPrice(500))}</output></label>
                        <input class="slider" type="range" id="priceSlider" min="0" max="1000" step="1" value="500">
                        <div class="slider-ends" aria-hidden="true"><span>$20</span><span>$5,000</span></div>
                        <button class="btn btn-primary" type="button" id="lockPrice">Lock in ${money(toPrice(500))}</button>
                    </div>
                </div>`;
            setPicture(stage.querySelector(".solo-photo img"), round.gpu);
            const slider = $("priceSlider");
            const sync = () => {
                const guess = money(toPrice(Number(slider.value)));
                $("priceOut").textContent = guess;
                $("lockPrice").textContent = `Lock in ${guess}`;
                slider.setAttribute("aria-valuetext", guess);
            };
            sync();
            slider.addEventListener("input", sync);
            $("lockPrice").addEventListener("click", () => {
                const guess = toPrice(Number(slider.value));
                const actual = price(round.gpu);
                const off = Math.abs(Math.log(guess / actual));
                slider.disabled = true;
                $("lockPrice").disabled = true;
                answer({ right: off <= Math.log(1.25), points: Math.max(0, Math.round(100 * (1 - off / Math.log(2)))),
                    gpu: round.gpu, status: `You said ${money(guess)}; it launched at ${money(actual)}.` });
            });
        },
    },
    {
        id: "budget",
        name: "Budget Pick",
        rule: "Four cards and their prices. Which one gave the most bandwidth per dollar?",
        make(rng, pool) {
            const priced = pool.filter((g) => Number.isFinite(price(g)) && Number.isFinite(bandwidth(g)));
            for (let tries = 0; tries < 40; tries++) {
                const four = sample(rng, priced, 4);
                if (four.length < 4) return null;
                const values = four.map((g) => bandwidth(g) / price(g));
                const best = Math.max(...values);
                // skip near-ties, where the answer would be a coin flip
                if (values.filter((v) => v > best * 0.92).length === 1) return { options: four, values };
            }
            return null;
        },
        render(round, stage, answer) {
            const bestIndex = round.values.indexOf(Math.max(...round.values));
            stage.innerHTML = `
                <h2 class="stage-q">Which card gave the most memory bandwidth for its launch price?</h2>
                <div class="budget">${round.options.map((g, i) => `
                    <button class="budget-pick" type="button" data-index="${i}">
                        <span class="budget-photo"><img alt="" decoding="async"></span>
                        <span class="budget-name">${escapeHTML(g.model)}</span>
                        <span class="budget-price">${escapeHTML(money(price(g)))}</span>
                        <span class="budget-value" hidden>${bandwidth(g).toLocaleString()} GB/s · ${(round.values[i]).toFixed(2)} GB/s per $</span>
                        <kbd aria-hidden="true">${i + 1}</kbd>
                    </button>`).join("")}</div>`;
            stage.querySelectorAll(".budget-photo img").forEach((img, i) => setPicture(img, round.options[i]));
            wireOptions(stage, (i) => {
                stage.querySelectorAll(".budget-pick").forEach((btn, j) => {
                    btn.disabled = true;
                    btn.querySelector(".budget-value").hidden = false;
                    if (j === bestIndex) btn.classList.add("is-right");
                    else if (j === i) btn.classList.add("is-wrong");
                });
                const right = i === bestIndex;
                const best = round.options[bestIndex];
                answer({ right, points: right ? 100 : 0, gpu: best,
                    status: `${best.model}: ${round.values[bestIndex].toFixed(2)} GB/s for every dollar.` });
            });
        },
    },
];

const modeById = (id) => MODES.find((m) => m.id === id);


// ============================================
// LOBBY
// ============================================

const RUN_NOTES = {
    standard: "Ten rounds; points for every right answer and a bonus for streaks.",
    blitz: "Sixty seconds. A right answer adds 2 seconds, a wrong one takes 5.",
    survival: "Three lives. Every five right answers, the wrong choices get closer.",
};

function modePool(mode) {
    let pool = catalog;
    if ($("favToggle").checked && favoriteIds) pool = pool.filter((g) => favoriteIds.has(String(g.id)));
    if (mode.picture) pool = pool.filter(hasPicture);
    return pool;
}

const MODE_ICONS = {
    classic: '<path d="M5 5h14v14H5z"/><path d="M8.5 9h7M8.5 12h7M8.5 15h4"/>',
    "higher-lower": '<path d="M7 18V6M4 9l3-3 3 3M17 6v12M14 15l3 3 3-3"/>',
    year: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8.5 3v4M15.5 3v4"/>',
    zoom: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5M11 8.5v5M8.5 11h5"/>',
    lineup: '<rect x="3.5" y="4" width="7" height="7" rx="1.5"/><rect x="13.5" y="4" width="7" height="7" rx="1.5"/><rect x="3.5" y="13" width="7" height="7" rx="1.5"/><rect x="13.5" y="13" width="7" height="7" rx="1.5"/>',
    price: '<path d="M12 3v18M16.5 7.5c-.8-1.3-2.4-2-4.5-2-2.6 0-4.3 1.3-4.3 3.2 0 4.6 9 2.3 9 6.8 0 1.9-1.9 3.3-4.7 3.3-2.2 0-4-.8-4.8-2.3"/>',
    budget: '<path d="M4 18 9 12l4 3 7-8"/><path d="M15 7h5v5"/>',
};

function icon(name) {
    return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MODE_ICONS[name] || ""}</svg>`;
}

function renderModeGrid() {
    const rng = makeRng(hashString("lobby"));
    $("modeGrid").innerHTML = MODES.map((mode) => {
        const pool = modePool(mode);
        const best = readStore(`gg-best-${mode.id}-${runKind}`, 0);
        const shot = pick(rng, catalog.filter(hasPicture));
        return `
            <button class="mode-card" type="button" data-mode="${mode.id}" ${pool.length < 4 ? "disabled" : ""}>
                <span class="mode-photo"><img alt="" loading="lazy" decoding="async" data-gpu="${escapeHTML(shot?.id)}"></span>
                <span class="mode-body">
                    <span class="mode-name">${icon(mode.id)}${escapeHTML(mode.name)}</span>
                    <span class="mode-rule">${escapeHTML(mode.rule)}</span>
                    <span class="mode-best">${pool.length < 4 ? "Needs at least 4 cards to play" : best ? `Your best: ${best.toLocaleString()}` : "Not played yet"}</span>
                </span>
            </button>`;
    }).join("");
    $("modeGrid").querySelectorAll("img[data-gpu]").forEach((img) => {
        const gpu = catalog.find((g) => String(g.id) === img.dataset.gpu);
        if (gpu) setPicture(img, gpu);
    });
    $("modeGrid").querySelectorAll("[data-mode]").forEach((card) => {
        card.addEventListener("click", () => startRun(card.dataset.mode, runKind, {}));
    });
}

function renderHeroWall() {
    const pictured = catalog.filter(hasPicture);
    const rng = makeRng(hashString(todayKey()));
    const six = sample(rng, pictured, 6);
    $("heroWall").innerHTML = six.map((g, i) => `<span class="wall-tile${i === 4 ? " is-mystery" : ""}"><img alt="" decoding="async"></span>`).join("");
    $("heroWall").querySelectorAll("img").forEach((img, i) => setPicture(img, six[i]));
    const years = catalog.map(year).filter(Number.isFinite);
    $("heroLead").textContent =
        `${catalog.length} real graphics cards from ${Math.min(...years)} to ${Math.max(...years)}, ` +
        "eight ways to play: specs, pictures, launch years and prices.";
}

function setupRunOptions() {
    document.querySelectorAll("[data-run]").forEach((btn) => {
        btn.addEventListener("click", () => {
            runKind = btn.dataset.run;
            document.querySelectorAll("[data-run]").forEach((b) => b.setAttribute("aria-checked", String(b === btn)));
            $("runNote").textContent = RUN_NOTES[runKind];
            renderModeGrid();
        });
    });

    const toggle = $("favToggle");
    if (!favoriteIds) {
        toggle.disabled = true;
        $("favToggleWrap").title = "Sign in on GPU Nexus and open the game there to play with your favorites.";
        $("favToggleWrap").classList.add("is-off");
    } else if (favoriteIds.size < 4) {
        toggle.disabled = true;
        $("favToggleWrap").title = `Save at least 4 favorites in the Finder first (you have ${favoriteIds.size}).`;
        $("favToggleWrap").classList.add("is-off");
    }
    toggle.addEventListener("change", renderModeGrid);
}


// ============================================
// RUNS
// ============================================

function showView(id) {
    ["lobby", "play", "results"].forEach((v) => { $(v).hidden = v !== id; });
    window.scrollTo(0, 0);
    $("main").focus({ preventScroll: true });
}

function updateTopStats() {
    $("scoreValue").textContent = (run?.score || 0).toLocaleString();
    $("streakValue").textContent = run?.streak || 0;
    $("roundValue").textContent = run?.round || 0;
}

function startRun(modeId, kind, { seed, vs } = {}) {
    const mode = modeById(modeId);
    if (!mode) return;
    const favorites = $("favToggle").checked && Boolean(favoriteIds);
    const pool = modePool(mode);
    if (pool.length < 4) return;
    const theSeed = seed ?? Math.floor(Math.random() * 2 ** 31);

    run?.cleanup?.();
    clearInterval(run?.timer);
    run = {
        mode, kind, pool, seed: theSeed, vs, favorites,
        rng: makeRng(theSeed),
        score: 0, streak: 0, bestStreak: 0, right: 0, round: 0,
        level: 1, lives: SURVIVAL_LIVES, timeLeft: BLITZ_SECONDS, previous: null,
        cleanup: null, timer: null, over: false,
    };

    $("playMode").textContent = mode.name;
    $("quitRun").textContent = "End run";
    $("playMeter").hidden = kind !== "blitz";
    $("lives").hidden = kind !== "survival";
    showView("play");
    if (kind === "blitz") startBlitzClock();
    nextRound();
}

function startBlitzClock() {
    let last = performance.now();
    run.timer = setInterval(() => {
        const now = performance.now();
        if (!$("reveal").hidden && run.kind !== "blitz") return;
        run.timeLeft -= (now - last) / 1000;
        last = now;
        drawProgress();
        if (run.timeLeft <= 0) endRun();
    }, 100);
}

function drawProgress() {
    if (run.kind === "standard") {
        $("playProgress").textContent = `Round ${run.round} of ${STANDARD_ROUNDS}`;
    } else if (run.kind === "blitz") {
        const left = Math.max(0, run.timeLeft);
        $("playProgress").textContent = `${Math.ceil(left)}s left · round ${run.round}`;
        $("playMeterFill").style.transform = `scaleX(${Math.min(1, left / BLITZ_SECONDS)})`;
    } else {
        $("playProgress").textContent = `Round ${run.round} · level ${run.level}`;
        $("lives").innerHTML = Array.from({ length: SURVIVAL_LIVES }, (_, i) =>
            `<svg class="life${i < run.lives ? "" : " is-lost"}" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>`).join("");
        $("lives").setAttribute("aria-label", `${run.lives} of ${SURVIVAL_LIVES} lives left`);
    }
    updateTopStats();
}

function nextRound() {
    if (!run || run.over) return;
    if (run.kind === "standard" && run.round >= STANDARD_ROUNDS) return endRun();
    run.cleanup?.();
    run.cleanup = null;

    const round = run.mode.make(run.rng, run.pool, run.level, run.previous);
    if (!round) return endRun();
    run.previous = round;
    run.round++;
    run.answered = false;
    $("reveal").hidden = true;
    drawProgress();
    run.mode.render(round, $("stage"), settleRound);
    $("stage").querySelector(".option, .btn-choice, .lineup-pick, .budget-pick, .slider")?.focus({ preventScroll: true });
}

function settleRound({ right, points, gpu, status }) {
    if (run.answered) return;
    run.answered = true;
    run.cleanup?.();

    if (right) {
        run.right++;
        run.streak++;
        run.bestStreak = Math.max(run.bestStreak, run.streak);
        // a streak bonus on top: +10% per answer in a row, up to +50%
        run.score += Math.round(points * (1 + Math.min(0.5, (run.streak - 1) * 0.1)));
        if (run.kind === "blitz") run.timeLeft += BLITZ_RIGHT;
        if (run.kind === "survival" && run.right % 5 === 0) run.level++;
    } else {
        run.streak = 0;
        run.score += points; // near misses on the sliders still score
        if (run.kind === "blitz") run.timeLeft -= BLITZ_WRONG;
        if (run.kind === "survival") run.lives--;
    }
    drawProgress();

    const finished =
        (run.kind === "survival" && run.lives <= 0) ||
        (run.kind === "blitz" && run.timeLeft <= 0) ||
        (run.kind === "standard" && run.round >= STANDARD_ROUNDS);

    // Blitz keeps moving: a short look at the answer, then the next round
    if (run.kind === "blitz" && !finished) {
        setTimeout(() => run && !run.over && nextRound(), right ? 450 : 900);
        return;
    }

    $("revealStatus").textContent = right ? "Right" : points > 0 ? `Close: +${points}` : "Not quite";
    $("revealStatus").className = `reveal-status ${right ? "is-good" : "is-bad"}`;
    $("revealModel").textContent = gpu.model;
    $("revealFacts").textContent = status || factLine(gpu);
    setPicture($("revealPhoto"), gpu);
    $("nextRound").textContent = finished ? "See your score" : "Next round";
    $("reveal").hidden = false;
    $("nextRound").focus({ preventScroll: true });
    run.finishAfterReveal = finished;
}

function endRun() {
    if (!run || run.over) return;
    run.over = true;
    run.cleanup?.();
    clearInterval(run.timer);
    $("reveal").hidden = true;

    const key = `gg-best-${run.mode.id}-${run.kind}`;
    const best = Math.max(readStore(key, 0), run.score);
    if (!run.favorites) writeStore(key, best);

    $("resultsMode").textContent = `${run.mode.name} · ${{ standard: "10 rounds", blitz: "Blitz 60s", survival: "Survival" }[run.kind]}`;
    $("resultsScore").textContent = run.score.toLocaleString();
    $("resultsRight").textContent = `${run.right} of ${run.round}`;
    $("resultsStreak").textContent = run.bestStreak;
    $("resultsBest").textContent = best.toLocaleString();
    $("resultsVs").hidden = run.vs == null;
    if (run.vs != null) {
        $("resultsVs").textContent = run.score > run.vs
            ? `You beat your friend's ${run.vs.toLocaleString()}.`
            : run.score === run.vs ? `A tie with your friend's ${run.vs.toLocaleString()}.`
                : `Your friend's ${run.vs.toLocaleString()} still stands.`;
    }
    $("shareRun").disabled = run.favorites;
    $("shareRun").title = run.favorites ? "Runs with your own favorites can't be shared." : "";
    $("shareNote").textContent = "";
    showView("results");
}

function challengeLink() {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("mode", run.mode.id);
    url.searchParams.set("run", run.kind);
    url.searchParams.set("seed", String(run.seed));
    url.searchParams.set("vs", String(run.score));
    return url.toString();
}

async function shareRun() {
    const link = challengeLink();
    try {
        await navigator.clipboard.writeText(link);
        $("shareNote").textContent = "Link copied. Your friend gets the same rounds and your score to beat.";
    } catch {
        $("shareNote").textContent = `Copy this link: ${link}`;
    }
}


// ============================================
// DAILY GPU
// ============================================

function todayKey() {
    return new Date().toISOString().slice(0, 10); // UTC, so everyone shares the day
}

function dailyGpu() {
    const sorted = [...catalog].sort((a, b) => Number(a.id) - Number(b.id));
    return sorted[hashString(`gpu-guessr-${todayKey()}`) % sorted.length];
}

const DAILY_ROWS = [
    { label: "Brand", test: (g, t) => (same(g.brand, t.brand) ? "hit" : "miss"), show: (g) => g.brand || "—" },
    { label: "Architecture", test: (g, t) => (same(g.architecture, t.architecture) ? "hit" : "miss"), show: (g) => g.architecture || "—" },
    { label: "VRAM", test: (g, t) => compare(vramGb(g), vramGb(t)), show: (g) => g.vram || "—" },
    { label: "Released", test: (g, t) => compare(year(g), year(t), 0), show: (g) => (Number.isFinite(year(g)) ? String(year(g)) : "—") },
    { label: "Launch price", test: (g, t) => compare(price(g), price(t), 0.15), show: (g) => money(price(g)) },
];

const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

// "hit", or which way the answer is: "up" (answer is higher) / "down"
function compare(guess, target, closeRatio = 0) {
    if (!Number.isFinite(guess) || !Number.isFinite(target)) return "miss";
    if (guess === target || (closeRatio && Math.abs(guess - target) <= target * closeRatio)) return "hit";
    return target > guess ? "up" : "down";
}

const ARROWS = {
    up: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
    down: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
};

function dailyState() {
    return readStore(`gg-daily-${todayKey()}`, { guesses: [], done: false, won: false });
}

function openDaily() {
    run?.cleanup?.();
    clearInterval(run?.timer);
    run = null;
    updateTopStats();
    $("playMode").textContent = "Today's GPU";
    $("quitRun").textContent = "Back to modes";
    $("playMeter").hidden = true;
    $("lives").hidden = true;
    $("reveal").hidden = true;
    showView("play");
    renderDaily();
}

function renderDaily() {
    const target = dailyGpu();
    const state = dailyState();
    const guesses = state.guesses.map((id) => catalog.find((g) => String(g.id) === String(id))).filter(Boolean);
    $("playProgress").textContent = `${todayKey()} · guess ${Math.min(guesses.length + 1, DAILY_TRIES)} of ${DAILY_TRIES}`;

    const stage = $("stage");
    stage.innerHTML = `
        <h2 class="stage-q">${state.done ? (state.won ? `Solved in ${guesses.length}.` : "Out of guesses.") : "Which GPU is today's card?"}</h2>
        ${state.done ? `
            <div class="daily-answer">
                <div class="daily-answer-photo"><img alt="" decoding="async"></div>
                <div><h3>${escapeHTML(target.model)}</h3><p>${escapeHTML(factLine(target))}</p></div>
            </div>` : `
            <form class="daily-form" id="dailyForm" novalidate>
                <label for="dailyInput">Your guess</label>
                <div class="daily-input-row">
                    <input id="dailyInput" list="dailyList" autocomplete="off" placeholder="Start typing a model, e.g. RTX 3080" required>
                    <button class="btn btn-primary" type="submit">Guess</button>
                </div>
                <p class="field-error" id="dailyError" role="alert" hidden></p>
                <datalist id="dailyList">${catalog.map((g) => `<option value="${escapeHTML(g.model)}"></option>`).join("")}</datalist>
            </form>`}
        <div class="daily-board" role="table" aria-label="Your guesses">
            <div class="daily-row is-head" role="row">
                <span role="columnheader">GPU</span>${DAILY_ROWS.map((r) => `<span role="columnheader">${r.label}</span>`).join("")}
            </div>
            ${guesses.map((g) => `
                <div class="daily-row" role="row">
                    <span class="daily-model" role="cell">${escapeHTML(g.model)}</span>
                    ${DAILY_ROWS.map((r) => {
                        const result = r.test(g, target);
                        const word = { hit: "right", miss: "wrong", up: "the answer is higher", down: "the answer is lower" }[result];
                        return `<span class="daily-tile is-${result}" role="cell" aria-label="${r.label}: ${escapeHTML(r.show(g))}, ${word}">
                            <small class="tile-label" aria-hidden="true">${r.label}</small>
                            <span class="tile-value">${escapeHTML(r.show(g))}${ARROWS[result] || ""}</span></span>`;
                    }).join("")}
                </div>`).join("")}
        </div>
        ${state.done ? `
            <div class="daily-done">
                <button class="btn btn-primary" type="button" id="dailyShare">Share your grid</button>
                <button class="btn btn-quiet" type="button" id="dailyBack">Back to the modes</button>
                <p class="share-note" id="dailyShareNote" role="status"></p>
            </div>` : ""}`;

    if (state.done) {
        setPicture(stage.querySelector(".daily-answer-photo img"), target);
        $("dailyShare").addEventListener("click", () => shareDaily(guesses, target, state.won));
        $("dailyBack").addEventListener("click", showLobby);
        return;
    }

    $("dailyInput").focus({ preventScroll: true });
    $("dailyForm").addEventListener("submit", (event) => {
        event.preventDefault();
        const text = $("dailyInput").value.trim();
        const gpu = catalog.find((g) => same(g.model, text));
        const error = $("dailyError");
        if (!gpu) {
            error.textContent = "Pick a model from the list; start typing and choose one.";
            error.hidden = false;
            $("dailyInput").setAttribute("aria-invalid", "true");
            return;
        }
        if (state.guesses.map(String).includes(String(gpu.id))) {
            error.textContent = `You already guessed the ${gpu.model}.`;
            error.hidden = false;
            return;
        }
        state.guesses.push(gpu.id);
        state.won = String(gpu.id) === String(target.id);
        state.done = state.won || state.guesses.length >= DAILY_TRIES;
        writeStore(`gg-daily-${todayKey()}`, state);
        if (state.done) recordDailyStreak(state.won);
        renderDaily();
    });
}

function recordDailyStreak(won) {
    const streak = readStore("gg-daily-streak", { last: null, count: 0 });
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    streak.count = won ? (streak.last === yesterday ? streak.count + 1 : 1) : 0;
    streak.last = todayKey();
    writeStore("gg-daily-streak", streak);
}

async function shareDaily(guesses, target, won) {
    const square = { hit: "🟩", miss: "🟥", up: "⬆️", down: "⬇️" };
    const lines = guesses.map((g) => DAILY_ROWS.map((r) => square[r.test(g, target)]).join(""));
    const text = `GPU Guessr · ${todayKey()} · ${won ? guesses.length : "X"}/${DAILY_TRIES}\n${lines.join("\n")}\n${location.origin}${location.pathname}`;
    try {
        await navigator.clipboard.writeText(text);
        $("dailyShareNote").textContent = "Copied. Paste it anywhere; it doesn't give the answer away.";
    } catch {
        $("dailyShareNote").textContent = text;
    }
}

function renderDailyCard() {
    const state = dailyState();
    const streak = readStore("gg-daily-streak", { count: 0 });
    const target = dailyGpu();
    setPicture($("dailyPhoto"), target);
    $("dailyCard").classList.toggle("is-done", state.done);
    $("dailyStatus").textContent = state.done
        ? (state.won ? `Solved today in ${state.guesses.length}.` : "Today's card beat you.") +
          (streak.count ? ` Daily streak: ${streak.count}.` : "") + " A new card at 00:00 UTC."
        : state.guesses.length
            ? `${state.guesses.length} of ${DAILY_TRIES} guesses used.`
            : "Not played yet today.";
    $("dailyOpen").textContent = state.done ? "See today's result" : state.guesses.length ? "Keep guessing" : "Play today's GPU";
}


// ============================================
// START
// ============================================

function showLobby() {
    run?.cleanup?.();
    clearInterval(run?.timer);
    if (run) run.over = true;
    run = null;
    updateTopStats();
    renderDailyCard();
    renderModeGrid();
    showView("lobby");
}

function setupKeys() {
    document.addEventListener("keydown", (event) => {
        if ($("play").hidden || event.target.matches("input, textarea") || event.metaKey || event.ctrlKey || event.altKey) return;
        const key = event.key.toLowerCase();
        if (!$("reveal").hidden && key === "enter") {
            event.preventDefault();
            $("nextRound").click();
            return;
        }
        const target =
            /^[1-4]$/.test(key) ? $("stage").querySelector(`[data-index="${Number(key) - 1}"]`)
                : key === "h" ? $("stage").querySelector('[data-choice="higher"]')
                    : key === "l" ? $("stage").querySelector('[data-choice="lower"]') : null;
        if (target && !target.disabled) {
            event.preventDefault();
            target.click();
        }
    });
}

function readChallenge() {
    const params = new URLSearchParams(location.search);
    const mode = modeById(params.get("mode"));
    const kind = ["standard", "blitz", "survival"].includes(params.get("run")) ? params.get("run") : null;
    const seed = Number(params.get("seed"));
    const vs = params.has("vs") ? Number(params.get("vs")) : null;
    if (!mode || !kind || !Number.isInteger(seed)) return;
    $("challengeText").textContent =
        `A friend scored ${Number.isFinite(vs) ? vs.toLocaleString() : "?"} in ${mode.name} ` +
        `(${{ standard: "10 rounds", blitz: "Blitz 60s", survival: "Survival" }[kind]}). Same rounds, your turn.`;
    $("challengeBanner").hidden = false;
    $("challengeStart").addEventListener("click", () => startRun(mode.id, kind, { seed, vs: Number.isFinite(vs) ? vs : null }));
}

async function setup() {
    setupKeys();
    $("quitRun").addEventListener("click", () => (run ? endRun() : showLobby()));
    $("nextRound").addEventListener("click", () => (run?.finishAfterReveal ? endRun() : nextRound()));
    $("playAgain").addEventListener("click", () => startRun(run.mode.id, run.kind, {}));
    $("backToModes").addEventListener("click", showLobby);
    $("shareRun").addEventListener("click", shareRun);
    $("playDaily").addEventListener("click", openDaily);
    $("dailyOpen").addEventListener("click", openDaily);
    $("quickPlay").addEventListener("click", () => startRun("classic", "standard", {}));

    try {
        [catalog, favoriteIds] = await Promise.all([fetchCatalog(), fetchFavorites()]);
        if (catalog.length < 4) throw new Error("The GPU list needs at least four cards to play.");
    } catch (error) {
        $("lobbyError").textContent = `${error.message} Refresh the page to try again.`;
        $("lobbyError").hidden = false;
        document.querySelectorAll("#lobby .btn, #lobby .segmented button").forEach((b) => { b.disabled = true; });
        return;
    }

    renderHeroWall();
    setupRunOptions();
    readChallenge();
    showLobby();
}

setup();
