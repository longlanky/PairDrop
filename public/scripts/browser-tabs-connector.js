class BrowserTabsConnector {
    constructor() {
        if (!('BroadcastChannel' in window)) return;

        this.bc = new BroadcastChannel('pairdrop');
        this.bc.addEventListener('message', e => this._onMessage(e));
        Events.on('broadcast-send', e => this._broadcastSend(e.detail));
        Events.on('pagehide', _ => this._close());
    }

    _close() {
        if (!this.bc) return;
        this.bc.close();
        this.bc = null;
    }

    _broadcastSend(message) {
        this.bc.postMessage(message);
    }

    _onMessage(e) {
        console.log('Broadcast:', e.data)
        switch (e.data.type) {
            case 'self-display-name-changed':
                Events.fire('self-display-name-changed', e.data.detail);
                break;
        }
    }

    static _getPeerIdsBrowser() {
        // `JSON.parse` throws if localStorage was modified or cleared by another tab
        try {
            const peerIdsBrowser = JSON.parse(localStorage.getItem('peer_ids_browser'));
            return Array.isArray(peerIdsBrowser) ? peerIdsBrowser : [];
        } catch (e) {
            console.error('Could not read peer_ids_browser', e);
            return [];
        }
    }

    static peerIsSameBrowser(peerId) {
        return this._getPeerIdsBrowser().indexOf(peerId) !== -1;
    }

    static async addPeerIdToLocalStorage() {
        const peerId = sessionStorage.getItem('peer_id');
        if (!peerId) return false;

        let peerIdsBrowser = this._getPeerIdsBrowser();
        peerIdsBrowser.push(peerId);
        peerIdsBrowser = peerIdsBrowser.filter(onlyUnique);
        localStorage.setItem('peer_ids_browser', JSON.stringify(peerIdsBrowser));

        return peerIdsBrowser;
    }

    static async removePeerIdFromLocalStorage(peerId) {
        let peerIdsBrowser = this._getPeerIdsBrowser();
        const index = peerIdsBrowser.indexOf(peerId);
        if (index > -1) peerIdsBrowser.splice(index, 1);
        localStorage.setItem('peer_ids_browser', JSON.stringify(peerIdsBrowser));
        return peerId;
    }


    static async removeOtherPeerIdsFromLocalStorage() {
        const peerId = sessionStorage.getItem('peer_id');
        if (!peerId) return false;

        let peerIdsBrowser = [peerId];
        localStorage.setItem('peer_ids_browser', JSON.stringify(peerIdsBrowser));
        return peerIdsBrowser;
    }
}