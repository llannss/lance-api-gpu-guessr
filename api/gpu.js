export default async function handler(
    req,
    res
) {

    if (
        req.method !==
        "GET"
    ) {

        return res
            .status(405)
            .json({
                error:
                    "Method not allowed"
            });
    }


    try {

        const response =
            await fetch(
                "https://lance-api-murex.vercel.app/gpus",
                {
                    headers: {
                        Accept:
                            "application/json",

                        "x-api-key":
                            process.env
                                .GPU_API_KEY
                    }
                }
            );


        const data =
            await response
                .json();


        if (!response.ok) {

            return res
                .status(
                    response.status
                )
                .json(
                    data
                );
        }


        res.setHeader(
            "Cache-Control",
            "s-maxage=300, stale-while-revalidate=600"
        );


        return res
            .status(200)
            .json(
                data
            );


    } catch (error) {

        console.error(
            error
        );


        return res
            .status(500)
            .json({
                error:
                    "Unable to load GPU data."
            });
    }
}