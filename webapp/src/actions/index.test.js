jest.mock('manifest', () => ({id: 'mattermost-webrtc-video'}), {virtual: true});

import {parseAuthorizedCallInvite} from './index';

describe('parseAuthorizedCallInvite', () => {
    test('accepts a complete versioned invite from the authenticated inbox', () => {
        expect(parseAuthorizedCallInvite({
            version: 1,
            type: 'invite',
            senderId: 'caller-1',
            sessionId: 'session-1',
            callId: 'call-1',
            payload: {audioOnly: true},
        })).toEqual({
            callerId: 'caller-1',
            signalSessionId: 'session-1',
            callId: 'call-1',
            audioOnly: true,
        });
    });

    test.each([
        null,
        {},
        {version: 2, type: 'invite', senderId: 'caller-1', sessionId: 'session-1', callId: 'call-1'},
        {version: 1, type: 'webrtc', senderId: 'caller-1', sessionId: 'session-1', callId: 'call-1'},
        {version: 1, type: 'invite', sessionId: 'session-1', callId: 'call-1'},
        {version: 1, type: 'invite', senderId: 'caller-1', callId: 'call-1'},
        {version: 1, type: 'invite', senderId: 'caller-1', sessionId: 'session-1'},
    ])('rejects an invalid authorized invite: %p', (raw) => {
        expect(parseAuthorizedCallInvite(raw)).toBeNull();
    });
});
