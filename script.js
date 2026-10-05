let allGPUs = [];

let currentGPU = null;
let currentAnswers = [];

let difficulty = "easy";

let score = 0;
let streak = 0;
let round = 1;

let roundFinished = false;


const $ = (id) =>
    document.getElementById(id);


// ============================================
// API
// ============================================

async function fetchGPUs() {

    const response =
        await fetch(
            "/api/gpus",
            {
                cache:
                    "no-store"
            }
        );


    const data =
        await response
            .json()
            .catch(
                () => ({})
            );


    if (!response.ok) {

        throw new Error(
            data.detail ||
            data.error ||
            "Unable to load GPU data."
        );
    }


    if (Array.isArray(data)) {
        return data;
    }


    if (
        Array.isArray(
            data.gpus
        )
    ) {
        return data.gpus;
    }


    if (
        Array.isArray(
            data.data
        )
    ) {
        return data.data;
    }


    return [];
}


// ============================================
// START GAME
// ============================================

async function setupGame() {

    setupDifficultyButtons();


    $("skipButton")
        ?.addEventListener(
            "click",
            skipRound
        );


    $("nextButton")
        ?.addEventListener(
            "click",
            nextRound
        );


    try {

        allGPUs =
            await fetchGPUs();


        // Remove unusable entries
        allGPUs =
            allGPUs.filter(
                (gpu) =>
                    gpu.id &&
                    gpu.model
            );


        if (
            allGPUs.length < 4
        ) {

            throw new Error(
                "At least four GPUs are required."
            );
        }


        $("gameLoading").hidden =
            true;


        $("gameContent").hidden =
            false;


        startRound();


    } catch (error) {

        console.error(
            error
        );


        $("gameLoading").textContent =
            "Unable to load GPU database.";
    }
}


// ============================================
// DIFFICULTY
// ============================================

function setupDifficultyButtons() {

    document
        .querySelectorAll(
            ".difficulty"
        )
        .forEach(
            (button) => {

                button.addEventListener(
                    "click",
                    () => {

                        difficulty =
                            button.dataset
                                .difficulty;


                        document
                            .querySelectorAll(
                                ".difficulty"
                            )
                            .forEach(
                                (item) =>
                                    item.classList
                                        .remove(
                                            "active"
                                        )
                            );


                        button.classList.add(
                            "active"
                        );


                        score = 0;
                        streak = 0;
                        round = 1;


                        updateStats();


                        startRound();
                    }
                );
            }
        );
}


// ============================================
// ROUND
// ============================================

function startRound() {

    roundFinished =
        false;


    $("resultPanel").hidden =
        true;


    currentGPU =
        randomItem(
            allGPUs
        );


    currentAnswers =
        createAnswerOptions(
            currentGPU
        );


    renderClues(
        currentGPU
    );


    renderAnswers();


    setText(
        "questionRound",
        round
    );


    updateStats();
}


// ============================================
// ANSWERS
// ============================================

function createAnswerOptions(
    correctGPU
) {

    const others =
        shuffle(
            allGPUs.filter(
                (gpu) =>
                    String(gpu.id) !==
                    String(correctGPU.id)
            )
        );


    return shuffle([
        correctGPU,
        ...others.slice(
            0,
            3
        )
    ]);
}


function renderAnswers() {

    const container =
        $("answerGrid");


    container.innerHTML =
        "";


    currentAnswers.forEach(
        (gpu) => {

            const button =
                document.createElement(
                    "button"
                );


            button.type =
                "button";


            button.className =
                "answer-button";


            button.textContent =
                gpu.model;


            button.addEventListener(
                "click",
                () =>
                    answerQuestion(
                        gpu,
                        button
                    )
            );


            container.appendChild(
                button
            );
        }
    );
}


// ============================================
// CLUES
// ============================================

function renderClues(
    gpu
) {

    const container =
        $("clueGrid");


    const clues =
        getClues(
            gpu
        );


    container.innerHTML =
        clues
            .map(
                (clue) => `

                    <article class="clue">

                        <span>
                            ${escapeHTML(
                                clue.label
                            )}
                        </span>

                        <strong>
                            ${escapeHTML(
                                clue.value
                            )}
                        </strong>

                    </article>

                `
            )
            .join("");
}


function getClues(
    gpu
) {

    if (
        difficulty ===
        "easy"
    ) {

        return [
            {
                label:
                    "Brand",

                value:
                    gpu.brand ||
                    "--"
            },

            {
                label:
                    "Architecture",

                value:
                    gpu.architecture ||
                    "--"
            },

            {
                label:
                    "VRAM",

                value:
                    gpu.vram ||
                    "--"
            },

            {
                label:
                    "Release Date",

                value:
                    gpu.release_date ||
                    "--"
            }
        ];
    }


    if (
        difficulty ===
        "medium"
    ) {

        return [
            {
                label:
                    "VRAM",

                value:
                    gpu.vram ||
                    "--"
            },

            {
                label:
                    "Memory Type",

                value:
                    gpu.memory_type ||
                    "--"
            },

            {
                label:
                    "Memory Bandwidth",

                value:
                    gpu.memory_bandwidth ||
                    (
                        gpu.memory_bandwidth_gbps
                            ? `${gpu.memory_bandwidth_gbps} GB/s`
                            : "--"
                    )
            },

            {
                label:
                    "Power",

                value:
                    gpu.power ||
                    "--"
            }
        ];
    }


    return [
        {
            label:
                "Memory Bus",

            value:
                gpu.memory_bus ||
                "--"
        },

        {
            label:
                "Boost Clock",

            value:
                gpu.boost_clock ||
                "--"
        },

        {
            label:
                "Process Node",

            value:
                gpu.process_node_nm
                    ? `${gpu.process_node_nm} nm`
                    : "--"
        },

        {
            label:
                "Recommended PSU",

            value:
                gpu.recommended_psu ||
                "--"
        }
    ];
}


// ============================================
// ANSWER QUESTION
// ============================================

function answerQuestion(
    selectedGPU,
    selectedButton
) {

    if (roundFinished) {
        return;
    }


    roundFinished =
        true;


    const correct =
        String(
            selectedGPU.id
        ) ===
        String(
            currentGPU.id
        );


    const buttons =
        document
            .querySelectorAll(
                ".answer-button"
            );


    buttons.forEach(
        (button) => {

            button.disabled =
                true;


            const gpu =
                currentAnswers.find(
                    (item) =>
                        item.model ===
                        button.textContent
                );


            if (
                String(
                    gpu?.id
                ) ===
                String(
                    currentGPU.id
                )
            ) {

                button.classList.add(
                    "correct"
                );
            }
        }
    );


    if (correct) {

        streak++;


        const points =
            getRoundPoints();


        score +=
            points;


        showResult(
            true,
            `+${points} points`
        );


    } else {

        streak =
            0;


        selectedButton
            .classList
            .add(
                "wrong"
            );


        showResult(
            false,
            `The correct answer was ${currentGPU.model}.`
        );
    }


    updateStats();
}


// ============================================
// SCORE
// ============================================

function getRoundPoints() {

    const basePoints = {

        easy:
            100,

        medium:
            150,

        hard:
            250

    };


    const bonus =
        Math.max(
            0,
            streak - 1
        ) * 25;


    return (
        basePoints[
            difficulty
        ] +
        bonus
    );
}


// ============================================
// RESULT
// ============================================

function showResult(
    correct,
    message
) {

    const panel =
        $("resultPanel");


    const status =
        $("resultStatus");


    panel.hidden =
        false;


    status.textContent =
        correct
            ? "✓ CORRECT"
            : "✕ INCORRECT";


    status.className =
        `result-status ${
            correct
                ? "correct"
                : "wrong"
        }`;


    setText(
        "resultGpu",
        currentGPU.model
    );


    setText(
        "resultMessage",
        message
    );
}


// ============================================
// NEXT / SKIP
// ============================================

function nextRound() {

    round++;

    startRound();
}


function skipRound() {

    if (roundFinished) {
        return;
    }


    streak =
        0;


    roundFinished =
        true;


    document
        .querySelectorAll(
            ".answer-button"
        )
        .forEach(
            (button) => {

                button.disabled =
                    true;


                if (
                    button.textContent ===
                    currentGPU.model
                ) {

                    button.classList.add(
                        "correct"
                    );
                }
            }
        );


    showResult(
        false,
        `Skipped. The answer was ${currentGPU.model}.`
    );


    updateStats();
}


// ============================================
// UI
// ============================================

function updateStats() {

    setText(
        "scoreValue",
        score.toLocaleString()
    );


    setText(
        "streakValue",
        streak
    );


    setText(
        "roundValue",
        round
    );
}


function setText(
    id,
    value
) {

    const element =
        $(id);


    if (element) {

        element.textContent =
            value;
    }
}


// ============================================
// UTILITIES
// ============================================

function randomItem(
    array
) {

    return array[
        Math.floor(
            Math.random() *
            array.length
        )
    ];
}


function shuffle(
    array
) {

    const copy =
        [...array];


    for (
        let i =
            copy.length - 1;

        i > 0;

        i--
    ) {

        const j =
            Math.floor(
                Math.random() *
                (i + 1)
            );


        [
            copy[i],
            copy[j]
        ] =
        [
            copy[j],
            copy[i]
        ];
    }


    return copy;
}


function escapeHTML(
    value
) {

    return String(
        value
    )
        .replaceAll(
            "&",
            "&amp;"
        )
        .replaceAll(
            "<",
            "&lt;"
        )
        .replaceAll(
            ">",
            "&gt;"
        )
        .replaceAll(
            '"',
            "&quot;"
        )
        .replaceAll(
            "'",
            "&#039;"
        );
}


// ============================================
// START
// ============================================

document.addEventListener(
    "DOMContentLoaded",
    setupGame
);