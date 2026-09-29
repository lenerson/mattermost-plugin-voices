export default class VoiceInviteController {
    constructor({searchUsers, sendInvite, respondInvite, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout}) {
        this.searchUsers = searchUsers;
        this.sendInvite = sendInvite;
        this.respondInvite = respondInvite;
        this.now = now;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.searchRequestId = 0;
        this.expiryTimer = null;
    }

    isExpired(invite) {
        const expiresAt = Number(invite && invite.expiresAt);
        return !Number.isFinite(expiresAt) || expiresAt <= this.now();
    }

    search(term) {
        const requestId = ++this.searchRequestId;
        if (term.trim().length < 2) {
            return Promise.resolve({requestId, users: [], searched: false});
        }
        return this.searchUsers(term).then((users) => ({
            requestId,
            users: Array.isArray(users) ? users : [],
            searched: true,
        }));
    }

    isCurrentSearch(requestId) {
        return requestId === this.searchRequestId;
    }

    invalidateSearch() {
        this.searchRequestId += 1;
    }

    send(roomId, userId) {
        if (!roomId || !userId) {
            return Promise.reject(new Error('A room and user are required to send an invitation.'));
        }
        return this.sendInvite(roomId, userId);
    }

    respond(invite, decision) {
        if (!invite || !invite.postId || !invite.inviteId || this.isExpired(invite)) {
            return Promise.reject(new Error('The voice invitation is no longer active.'));
        }
        return this.respondInvite(invite.postId, invite.inviteId, decision);
    }

    scheduleExpiry(invite, onExpire) {
        this.clearExpiry();
        if (this.isExpired(invite)) {
            return false;
        }
        this.expiryTimer = this.setTimeoutFn(() => {
            this.expiryTimer = null;
            onExpire();
        }, Number(invite.expiresAt) - this.now());
        return true;
    }

    clearExpiry() {
        if (this.expiryTimer) {
            this.clearTimeoutFn(this.expiryTimer);
            this.expiryTimer = null;
        }
    }
}
