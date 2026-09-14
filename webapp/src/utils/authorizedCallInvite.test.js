import {deliverAuthorizedCallInvite} from './authorizedCallInvite';

describe('deliverAuthorizedCallInvite', () => {
    const args = () => ({
        callId: 'call-1',
        peerId: 'peer-1',
        audioOnly: true,
        createHub: jest.fn(),
        sendInvite: jest.fn(),
        onHub: jest.fn(),
    });

    test('registers the authorized hub before delivering a private invite', async () => {
        const input = args();
        const hub = {session: {sessionId: 'session-1'}, close: jest.fn()};
        input.createHub.mockResolvedValue(hub);
        input.sendInvite.mockResolvedValue();

        await expect(deliverAuthorizedCallInvite(input)).resolves.toBe(hub);
        expect(input.onHub).toHaveBeenCalledWith(hub);
        expect(input.onHub.mock.invocationCallOrder[0]).toBeLessThan(input.sendInvite.mock.invocationCallOrder[0]);
        expect(input.sendInvite).toHaveBeenCalledWith(hub.session, 'peer-1', {audioOnly: true});
        expect(hub.close).not.toHaveBeenCalled();
    });

    test('rejects without delivering an invite when session creation fails', async () => {
        const input = args();
        const error = new Error('unavailable');
        input.createHub.mockRejectedValue(error);

        await expect(deliverAuthorizedCallInvite(input)).rejects.toBe(error);
        expect(input.onHub).not.toHaveBeenCalled();
        expect(input.sendInvite).not.toHaveBeenCalled();
    });

    test('closes the authorized hub when invite delivery fails', async () => {
        const input = args();
        const hub = {session: {sessionId: 'session-1'}, close: jest.fn()};
        input.createHub.mockResolvedValue(hub);
        input.sendInvite.mockRejectedValue(new Error('offline'));

        await expect(deliverAuthorizedCallInvite(input)).rejects.toThrow('offline');
        expect(hub.close).toHaveBeenCalledTimes(1);
    });

    test('closes the authorized hub when listener registration fails', async () => {
        const input = args();
        const hub = {session: {sessionId: 'session-1'}, close: jest.fn()};
        input.createHub.mockResolvedValue(hub);
        input.onHub.mockRejectedValue(new Error('listener failed'));

        await expect(deliverAuthorizedCallInvite(input)).rejects.toThrow('listener failed');
        expect(input.sendInvite).not.toHaveBeenCalled();
        expect(hub.close).toHaveBeenCalledTimes(1);
    });
});
