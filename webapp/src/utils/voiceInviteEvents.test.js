jest.mock('manifest', () => ({id: 'mattermost-webrtc-video'}), {virtual: true});

import {
    emitVoiceInvite,
    emitVoiceInviteDecision,
    registerVoiceInviteEvents,
    subscribeVoiceInviteDecisions,
    subscribeVoiceInvites,
    VOICE_INVITE_EVENT,
} from './voiceInviteEvents';

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

    test('forwards a local decision from the direct-message action', () => {
        const listener = jest.fn();
        const unsubscribe = subscribeVoiceInviteDecisions(listener);
        const invite = {inviteId: 'invite-1', roomId: 'room-1'};

        emitVoiceInviteDecision(invite, 'accepted');
        expect(listener).toHaveBeenCalledWith({invite, decision: 'accepted'});

        unsubscribe();
        emitVoiceInviteDecision(invite, 'declined');
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
