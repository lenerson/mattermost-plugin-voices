import {deliverAuthorizedCallInvite} from './authorizedCallInvite';

describe('deliverAuthorizedCallInvite', () => {
    const args = () => ({
        callId: 'call-1',
        peerId: 'peer-1',
        audioOnly: true,
        createHub: jest.fn(),
        sendInvite: jest.fn(),
        legacyHub: {broadcast: jest.fn()},
        legacyMessage: {channel: 'call-peer-1', payload: {callerId: 'caller-1'}},
    });

    test('delivers a private invite without publishing the legacy fallback', async () => {
        const input = args();
        const hub = {session: {sessionId: 'session-1'}, close: jest.fn()};
        input.createHub.mockResolvedValue(hub);
        input.sendInvite.mockResolvedValue();

        await expect(deliverAuthorizedCallInvite(input)).resolves.toBe(hub);
        expect(input.sendInvite).toHaveBeenCalledWith(hub.session, 'peer-1', {audioOnly: true});
        expect(input.legacyHub.broadcast).not.toHaveBeenCalled();
        expect(hub.close).not.toHaveBeenCalled();
    });

    test('falls back when session creation fails', async () => {
        const input = args();
        input.createHub.mockRejectedValue(new Error('unavailable'));

        await expect(deliverAuthorizedCallInvite(input)).resolves.toBeNull();
        expect(input.sendInvite).not.toHaveBeenCalled();
        expect(input.legacyHub.broadcast).toHaveBeenCalledWith('call-peer-1', {callerId: 'caller-1'});
    });

    test('closes the authorized hub before falling back when invite delivery fails', async () => {
        const input = args();
        const hub = {session: {sessionId: 'session-1'}, close: jest.fn()};
        input.createHub.mockResolvedValue(hub);
        input.sendInvite.mockRejectedValue(new Error('offline'));

        await expect(deliverAuthorizedCallInvite(input)).resolves.toBeNull();
        expect(hub.close).toHaveBeenCalledTimes(1);
        expect(input.legacyHub.broadcast).toHaveBeenCalledWith('call-peer-1', {callerId: 'caller-1'});
    });
});
