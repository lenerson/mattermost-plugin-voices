import {id as pluginId} from 'manifest';

import debug from './debug';

export const VOICE_INVITE_EVENT = `custom_${pluginId}_voice_invite`;

const listeners = new Set();
const decisionListeners = new Set();

export function emitVoiceInvite(invite) {
    for (const listener of Array.from(listeners)) {
        try {
            listener(invite || {});
        } catch (error) {
            debug('voice invite event listener failed', error);
        }
    }
}

export function subscribeVoiceInvites(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function emitVoiceInviteDecision(invite, decision) {
    for (const listener of Array.from(decisionListeners)) {
        try {
            listener({invite, decision});
        } catch (error) {
            debug('voice invite decision listener failed', error);
        }
    }
}

export function subscribeVoiceInviteDecisions(listener) {
    decisionListeners.add(listener);
    return () => decisionListeners.delete(listener);
}

export function registerVoiceInviteEvents(registry) {
    return registry.registerWebSocketEventHandler(VOICE_INVITE_EVENT, (message) => {
        emitVoiceInvite((message && message.data) || {});
    });
}
