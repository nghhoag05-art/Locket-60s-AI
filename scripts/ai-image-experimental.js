/*
 * Locket image-request experiment: returns the input image unchanged.
 * This script does not generate a new AI image.
 *
 * Request-only adaptation of dtuandzxyz/Locket-Filter-Module:
 *   js/locket_pb_req.js
 * Source author: dinhtuan07. Distributor: Hakaiz.
 * Source commit: 9c2ea58aaea3f6d9258b60d3cf1621ea6a4ccdce
 * Source blob: 30f675e9fde915352871a1d57d0ec149e81b30b8
 *
 * Only a known image-URL field at an exact Locket generation endpoint is
 * answered with a local mock 200. Unknown input is passed through unchanged.
 * No external AI service, UID sync, profile update, or Photobooth state is used.
 */
(function () {
    var finished = false;

    function finish(value) {
        if (finished) return;
        finished = true;
        $done(value || {});
    }

    function isRecord(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function isImageUrl(value) {
        return typeof value === "string" &&
            /^https?:\/\/[^\/\s?#]+(?:[\/?#][^\s]*)?$/i.test(value);
    }

    function readUrl(record, fields) {
        if (!isRecord(record)) return "";
        for (var i = 0; i < fields.length; i++) {
            var key = fields[i];
            if (Object.prototype.hasOwnProperty.call(record, key) && isImageUrl(record[key])) {
                return record[key];
            }
        }
        return "";
    }

    function buildMock200Response(inputUrl) {
        return {
            status: 200,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Access-Control-Allow-Origin": "*"
            },
            body: JSON.stringify({
                result: {
                    outputUrl: inputUrl,
                    output_url: inputUrl,
                    url: inputUrl,
                    imageUrl: inputUrl,
                    image_url: inputUrl,
                    status: 200,
                    data: {
                        outputUrl: inputUrl,
                        output_url: inputUrl,
                        url: inputUrl,
                        imageUrl: inputUrl,
                        image_url: inputUrl
                    }
                }
            })
        };
    }

    try {
        if (typeof $response !== "undefined" || typeof $request === "undefined" || !$request) {
            return finish({});
        }
        var endpoint = /^https?:\/\/(?:api\.locketcamera\.com|us-central1-locket-4252a\.cloudfunctions\.net)\/generateFilteredImage\/?(?:\?[^#]*)?$/i;
        if (typeof $request.url !== "string" || !endpoint.test($request.url)) return finish({});
        if ($request.method && String($request.method).toUpperCase() !== "POST") return finish({});
        if (typeof $request.body !== "string" || !$request.body) return finish({});

        var requestBody = JSON.parse($request.body);
        if (!isRecord(requestBody)) return finish({});
        var inputUrl = readUrl(requestBody, ["imageUrl", "image_url", "inputUrl", "input_url", "url", "downloadUrl", "download_url"]);
        if (!inputUrl) inputUrl = readUrl(requestBody.data, ["imageUrl", "image_url", "url", "inputUrl"]);
        if (!inputUrl) return finish({});

        // The output URL is deliberately the SAME input URL, not an AI result.
        return finish({ response: buildMock200Response(inputUrl) });
    } catch (error) {
        return finish({});
    }
})();
