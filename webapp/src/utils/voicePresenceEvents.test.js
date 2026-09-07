jest.mock('manifest', () => ({id: 'mattermost-webrtc-video'}), {virtual: true});

import {
    registerVoicePresenceEvents,
    subscribeVoicePresenceChanges,
    VOICE_PRESENCE_EVENT,
} from './voicePresenceEvents';

function captureWebsocketHandler(holder) {
    return (event, handler) => {
        holder.handler = handler;
    };
}

describe('voicePresenceEvents', () => {
    test('forwards plugin websocket events to subscribers until they unsubscribe', () => {
        const captured = {};
        const registry = {
            registerWebSocketEventHandler: jest.fn(captureWebsocketHandler(captured)),
        };
        const listener = jest.fn();
        const unsubscribe = subscribeVoicePresenceChanges(listener);

        registerVoicePresenceEvents(registry);
        expect(registry.registerWebSocketEventHandler).toHaveBeenCalledWith(
            VOICE_PRESENCE_EVENT,
            expect.any(Function),
        );

        captured.handler({data: {roomId: 'room-1'}});
        expect(listener).toHaveBeenCalledWith({roomId: 'room-1'});

        unsubscribe();
        captured.handler({data: {roomId: 'room-2'}});
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
