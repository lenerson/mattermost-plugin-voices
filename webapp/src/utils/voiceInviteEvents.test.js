jest.mock('manifest', () => ({id: 'mattermost-webrtc-video'}), {virtual: true});

import {emitVoiceInvite, registerVoiceInviteEvents, subscribeVoiceInvites, VOICE_INVITE_EVENT} from './voiceInviteEvents';

function captureWebsocketHandler(captured) {
    return (event, handler) => {
        captured.event = event;
        captured.handler = handler;
        return jest.fn();
    };
}

describe('voiceInviteEvents', () => {
    test('forwards targeted invite events until the listener unsubscribes', () => {
        const captured = {};
        const registry = {
            registerWebSocketEventHandler: jest.fn(captureWebsocketHandler(captured)),
        };
        const listener = jest.fn();
        const unsubscribe = subscribeVoiceInvites(listener);

        registerVoiceInviteEvents(registry);
        expect(captured.event).toBe(VOICE_INVITE_EVENT);

        captured.handler({data: {roomId: 'room-1', inviterId: 'user-1'}});
        expect(listener).toHaveBeenCalledWith({roomId: 'room-1', inviterId: 'user-1'});

        unsubscribe();
        emitVoiceInvite({roomId: 'room-2'});
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
