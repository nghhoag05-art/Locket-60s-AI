/*
 * Locket image editing client. No local mock or API key is used here.
 * Configure LOCKET_AI_ENDPOINT and LOCKET_AI_TOKEN in the local setup page.
 * Missing configuration or a failed backend call leaves the original request intact.
 * Surge API reference: https://manual.nssurge.com/scripting/api.html
 * Request result: https://manual.nssurge.com/scripting/http-request.html
 * Shadowrocket/iPhone compatibility still requires an actual device test.
 */
(function () {
    var finished = false;
    var watchdog;
    var endpointPattern = /^https:\/\/(?:api\.locketcamera\.com|us-central1-locket-4252a\.cloudfunctions\.net)\/generateFilteredImage\/?(?:\?[^#]*)?$/i;
    var imageFields = ["imageUrl", "image_url", "inputUrl", "input_url", "url", "downloadUrl", "download_url"];
    var prompts = {
        beard: "Add a natural full beard. Preserve the person's identity, pose and background.",
        blonde_bleached: "Change the hair to a natural bleached blonde. Preserve the face, pose and background.",
        bob_cut: "Give the person a realistic bob haircut. Preserve identity, pose and background.",
        clown: "Add playful clown makeup and a red clown nose. Preserve identity and background.",
        princess: "Add a fairy-tale princess outfit and a small crown. Preserve identity, pose and background.",
        wedding: "Add elegant wedding attire. Preserve the people, faces, pose and background.",
        cowboy_cowgirl: "Add a cowboy hat and western outfit. Preserve identity, pose and background.",
        happy_birthday: "Add a birthday cake, colorful balloons and subtle confetti. Preserve the people and background.",
        disco_lights: "Add colorful disco lighting and a festive atmosphere. Preserve faces, pose and scene.",
        slimed: "Add playful green slime effects to clothing and surroundings. Preserve identity and pose.",
        cutesy: "Add a cute pastel style with small hearts and sparkles. Preserve identity, pose and background."
    };

    function finish(value) {
        if (finished) return;
        finished = true;
        if (typeof clearTimeout === "function" && watchdog !== undefined) clearTimeout(watchdog);
        $done(value || {});
    }

    function record(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    // Avoid relying on the URL WebAPI, which is not present in every JSC runtime.
    function httpsUrl(value, allowQuery) {
        if (typeof value !== "string" || value.length > 8192 || value !== value.trim()) return null;
        var match = /^https:\/\/([^\/?#\s]+)(\/[^#\s]*)?$/i.exec(value);
        if (!match) return null;
        var authority = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/i.exec(match[1]);
        if (!authority) return null;
        var host = authority[1].toLowerCase();
        if (host.indexOf(".") < 0 || /^\d+(?:\.\d+){3}$/.test(host)) return null;
        if (!host.split(".").every(function (label) {
            return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label);
        })) return null;
        var port = authority[2] ? Number(authority[2]) : 443;
        if (port < 1 || port > 65535) return null;
        var path = match[2] || "/";
        if (!allowQuery && path.indexOf("?") !== -1) return null;
        return { origin: "https://" + host + (port === 443 ? "" : ":" + port), path: path };
    }

    function readImage(obj, fields) {
        if (!record(obj)) return "";
        for (var i = 0; i < fields.length; i++) {
            if (Object.prototype.hasOwnProperty.call(obj, fields[i]) && httpsUrl(obj[fields[i]], true)) {
                return obj[fields[i]];
            }
        }
        return "";
    }

    function readPrompt(body) {
        var containers = [body, body.data];
        var fields = ["prompt", "text_prompt", "instruction"];
        for (var i = 0; i < containers.length; i++) {
            if (!record(containers[i])) continue;
            for (var j = 0; j < fields.length; j++) {
                var value = containers[i][fields[j]];
                if (typeof value === "string" && value.trim()) {
                    var text = value.trim();
                    return text.length <= 2000 ? text : "";
                }
            }
        }
        for (var k = 0; k < containers.length; k++) {
            if (!record(containers[k])) continue;
            var id = containers[k].filterId || containers[k].filter_id;
            if (typeof id === "string") {
                id = id.trim().toLowerCase();
                if (Object.prototype.hasOwnProperty.call(prompts, id)) return prompts[id];
            }
        }
        return "";
    }

    function nativeResponse(outputUrl) {
        var urls = { outputUrl: outputUrl, output_url: outputUrl, url: outputUrl, imageUrl: outputUrl, image_url: outputUrl };
        return {
            response: {
                status: 200,
                headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
                body: JSON.stringify({ result: {
                    outputUrl: outputUrl, output_url: outputUrl, url: outputUrl,
                    imageUrl: outputUrl, image_url: outputUrl, status: 200, data: urls
                } })
            }
        };
    }

    try {
        if (typeof $response !== "undefined" || typeof $request === "undefined" || !$request) return finish({});
        if (typeof $request.url !== "string" || !endpointPattern.test($request.url)) return finish({});
        if ($request.method && String($request.method).toUpperCase() !== "POST") return finish({});
        if (typeof $request.body !== "string" || !$request.body || $request.body.length > 65536) return finish({});
        if (typeof $persistentStore === "undefined" || typeof $persistentStore.read !== "function") return finish({});
        if (typeof $httpClient === "undefined" || typeof $httpClient.post !== "function" || typeof setTimeout !== "function") return finish({});

        var endpointValue = $persistentStore.read("LOCKET_AI_ENDPOINT");
        var tokenValue = $persistentStore.read("LOCKET_AI_TOKEN");
        var endpoint = httpsUrl(typeof endpointValue === "string" ? endpointValue.trim() : "", false);
        var token = typeof tokenValue === "string" ? tokenValue.trim() : "";
        if (!endpoint || (endpoint.path !== "/" && endpoint.path !== "/v1/images/edit")) return finish({});
        if (!/^[A-Za-z0-9._~+\/-]{24,256}={0,2}$/.test(token)) return finish({});

        var body = JSON.parse($request.body);
        if (!record(body)) return finish({});
        var inputUrl = readImage(body, imageFields) || readImage(body.data, ["imageUrl", "image_url", "url", "inputUrl"]);
        var prompt = readPrompt(body);
        if (!inputUrl || !prompt) return finish({});
        var input = httpsUrl(inputUrl, true);

        // HTTP client timeout is in seconds. The local guard stays below the module's 60 seconds.
        watchdog = setTimeout(function () { finish({}); }, 50000);
        $httpClient.post({
            url: endpoint.origin + "/v1/images/edit",
            headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify({ imageUrl: inputUrl, prompt: prompt }),
            timeout: 45,
            "auto-redirect": false,
            "auto-cookie": false
        }, function (error, response, data) {
            if (finished) return;
            try {
                if (error || !response || Number(response.status || response.statusCode) !== 200) return finish({});
                if (typeof data !== "string" || data.length > 65536) return finish({});
                var result = JSON.parse(data);
                var outputUrl = record(result) ? result.outputUrl : "";
                var output = httpsUrl(outputUrl, false);
                if (!output || output.origin !== endpoint.origin) return finish({});
                if (!/^\/images\/[A-Za-z0-9_-]{24,128}\.(?:png|jpe?g|webp)$/.test(output.path)) return finish({});
                if (output.origin === input.origin && output.path === input.path) return finish({});
                return finish(nativeResponse(outputUrl));
            } catch (error) {
                return finish({});
            }
        });
    } catch (error) {
        return finish({});
    }
})();
