export default async function handler(req, res) {

    if (req.method !== "GET") {
        return res.status(405).json({
            error: "Method not allowed"
        });
    }

    try {

        const apiKey =
            process.env.GPU_API_KEY;

        if (!apiKey) {
            return res.status(500).json({
                error: "GPU_API_KEY is missing"
            });
        }

        const response = await fetch(
            "https://lance-api-murex.vercel.app/gpus",
            {
                headers: {
                    Accept: "application/json",
                    "x-api-key": apiKey
                }
            }
        );

        const text =
            await response.text();

        let data;

        try {
            data = JSON.parse(text);
        } catch {
            data = {
                raw: text
            };
        }

        if (!response.ok) {
            return res.status(response.status).json({
                error: "GPU API request failed",
                status: response.status,
                response: data
            });
        }

        return res.status(200).json(data);

    } catch (error) {

        console.error(
            "GPU proxy error:",
            error
        );

        return res.status(500).json({
            error: "Unable to load GPU data",
            message: error.message
        });
    }
}
