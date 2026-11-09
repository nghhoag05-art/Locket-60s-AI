// Locket only — RevenueCat response handler.
// Preserves the older module's simulated Gold JSON; does not create a real purchase.
(function () {
    try {
        var headers = ($request && $request.headers) || {};
        var ua = String(headers["User-Agent"] || headers["user-agent"] || "");
        if (!/Locket/i.test(ua)) return $done({});
        var data = JSON.parse($response.body);
        if (!data || !data.subscriber || typeof data.subscriber !== "object") return $done({});
        data.subscriber.subscriptions = data.subscriber.subscriptions || {};
        data.subscriber.entitlements = data.subscriber.entitlements || {};
        // Keep the original identifiers and sample subscription values for compatibility.
        var productId = "locket_1600_1y";
        var purchaseDate = "2027-11-25T10:10:14Z";
        var expirationDate = "9999-01-09T10:10:14Z";
        data.subscriber.subscriptions[productId] = {
            auto_resume_date: null,
            display_name: productId,
            is_sandbox: true,
            ownership_type: "PURCHASED",
            billing_issues_detected_at: null,
            management_url: "https://apps.apple.com/account/subscriptions",
            period_type: "normal",
            price: {amount: 399000, currency: "VND"},
            expires_date: expirationDate,
            grace_period_expires_date: null,
            refunded_at: null,
            unsubscribe_detected_at: null,
            original_purchase_date: "2027-11-25T10:10:15Z",
            purchase_date: purchaseDate,
            store: "app_store",
            store_transaction_id: "2000001108724193"
        };
        data.subscriber.entitlements.Gold = {
            grace_period_expires_date: null,
            purchase_date: purchaseDate,
            product_identifier: productId,
            expires_date: expirationDate
        };
        $done({body: JSON.stringify(data)});
    } catch (err) {
        $done({});
    }
})();
