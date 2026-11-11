/* Refresh Locket Remote Config without forwarding conditional cache validators.
 * This only changes cache headers; authentication and request bodies are untouched.
 */
(function () {
    if (typeof $response !== "undefined" || typeof $request === "undefined" || !$request ||
        !/^https:\/\/firebaseremoteconfig\.googleapis\.com\/v1\/projects\/locket-4252a\//.test(String($request.url || ""))) {
        return $done({});
    }
    var source = $request.headers;
    if (!source || typeof source !== "object" || Array.isArray(source)) return $done({});
    var headers = {};
    Object.keys(source).forEach(function (key) {
        var lower = key.toLowerCase();
        if (lower !== "if-none-match" && lower !== "if-modified-since" && lower !== "x-goog-if-none-match") {
            headers[key] = source[key];
        }
    });
    $done({ headers: headers });
})();
