import {id as pluginId} from 'manifest';

import debug from './debug';

export const VOICE_PRESENCE_EVENT = `custom_${pluginId}_voice_presence`;

const listeners = new Set();

export function emitVoicePresenceChange(change) {
    for (const listener of Array.from(listeners)) {
        try {
            listener(change || {});
        } catch (error) {
            debug('voice presence event listener failed', error);
        }
    }
}

export function subscribeVoicePresenceChanges(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function registerVoicePresenceEvents(registry) {
    return registry.registerWebSocketEventHandler(VOICE_PRESENCE_EVENT, (message) => {
        emitVoicePresenceChange((message && message.data) || {});
    });
}
