// OpenRCT2 Emscripten pre-js for WebSocket proxy support

var Module = Module || {};

Module['websocket'] = Module['websocket'] || {};
Module['websocket']['url'] = function (host, port, proto) {
    if (typeof window !== 'undefined' && window.openrct2_websocket_proxy) {
        var base = window.openrct2_websocket_proxy;
        if (base.endsWith('/')) {
            base = base.slice(0, -1);
        }
        return base + '/connect/' + host + '/' + port;
    }

    if (typeof location !== 'undefined' && location.protocol === 'https:') {
        return 'wss://';
    }

    return null;
};

if (typeof window !== 'undefined') {
    window.openrct2_fetch_server_list = function () {
        var proxy = window.openrct2_websocket_proxy || '';
        var proxyHttp = proxy.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
        if (proxyHttp.endsWith('/')) {
            proxyHttp = proxyHttp.slice(0, -1);
        }

        var url = proxyHttp ? (proxyHttp + '/servers') : (window.openrct2_master_server_url || 'https://servers.openrct2.io');

        try { console.log('[OpenRCT2] Fetching server list from:', url); } catch (e) {}

        fetch(url)
            .then(function (res) { return res.json(); })
            .then(function (data) {
                try {
                    console.log('[OpenRCT2] Server list received:', Array.isArray(data) ? data.length : (data.servers ? data.servers.length : 'unknown'));
                } catch (e) {}
                if (Module && Module.ccall) {
                    Module.ccall('OpenRCT2ServerListResponse', null, ['string'], [JSON.stringify(data)]);
                }
            })
            .catch(function () {
                try { console.log('[OpenRCT2] Server list fetch failed'); } catch (e) {}
                if (Module && Module.ccall) {
                    Module.ccall('OpenRCT2ServerListResponse', null, ['string'], ['']);
                }
            });
    };
}

Module['preRun'] = Module['preRun'] || [];
Module['preRun'].push(function () {
    if (typeof SOCKFS === 'undefined' || !SOCKFS.websocket_sock_ops) {
        return;
    }

    if (!SOCKFS.websocket_sock_ops.createPeer_) {
        // Patch SOCKFS to call Module.websocket.url as a function
        SOCKFS.websocket_sock_ops.createPeer_ = SOCKFS.websocket_sock_ops.createPeer;
        SOCKFS.websocket_sock_ops.createPeer = function (sock, addr, port) {
            var func = Module['websocket']['url'];
            Module['websocket']['url'] = func(addr, port, (sock.type === 2) ? 'udp' : 'tcp');
            var ret = SOCKFS.websocket_sock_ops.createPeer_(sock, addr, port);
            Module['websocket']['url'] = func;
            return ret;
        };
    }
});
