// Locket only — clear RevenueCat ETag when the request identifies Locket.
(function () {
    var headers = Object.assign({}, ($request && $request.headers) || {});
    var ua = String(headers["User-Agent"] || headers["user-agent"] || "");
    if (!/Locket/i.test(ua)) return $done({});
    Object.keys(headers).forEach(function (key) {
        if (key.toLowerCase() === "x-revenuecat-etag") delete headers[key];
    });
    headers["X-RevenueCat-ETag"] = "";
    $done({headers: headers});
})();
