import VoiceInviteController from './voiceInviteController';

const activeInvite = {postId: 'post-1', inviteId: 'invite-1', expiresAt: 200};

describe('VoiceInviteController', () => {
    test('keeps only the latest user search result and sends valid invitations', async () => {
        const controller = new VoiceInviteController({
            searchUsers: jest.fn(() => Promise.resolve([{id: 'user-2'}])),
            sendInvite: jest.fn(() => Promise.resolve()),
            respondInvite: jest.fn(),
        });

        const first = controller.search('ma');
        const second = controller.search('mat');
        const result = await second;

        expect(await first).toEqual(expect.objectContaining({searched: true}));
        expect(controller.isCurrentSearch(result.requestId)).toBe(true);
        expect(result.users).toEqual([{id: 'user-2'}]);
        await controller.send('room-1', 'user-2');
        expect(controller.sendInvite).toHaveBeenCalledWith('room-1', 'user-2');
    });

    test('rejects invalid, expired, and stale invitation operations', async () => {
        const controller = new VoiceInviteController({
            searchUsers: jest.fn(),
            sendInvite: jest.fn(),
            respondInvite: jest.fn(),
            now: () => 200,
        });

        await expect(controller.send('', 'user-2')).rejects.toThrow('room and user');
        await expect(controller.respond(activeInvite, 'accepted')).rejects.toThrow('no longer active');
        expect(controller.respondInvite).not.toHaveBeenCalled();
    });

    test('expires an active invitation once and cancels a replaced timer', () => {
        const timers = [];
        const clearTimeoutFn = jest.fn();
        const controller = new VoiceInviteController({
            searchUsers: jest.fn(),
            sendInvite: jest.fn(),
            respondInvite: jest.fn(),
            now: () => 100,
            setTimeoutFn: (callback) => {
                timers.push(callback);
                return callback;
            },
            clearTimeoutFn,
        });
        const onExpire = jest.fn();

        expect(controller.scheduleExpiry(activeInvite, onExpire)).toBe(true);
        controller.scheduleExpiry({...activeInvite, expiresAt: 300}, onExpire);
        timers[1]();

        expect(clearTimeoutFn).toHaveBeenCalledWith(timers[0]);
        expect(onExpire).toHaveBeenCalledTimes(1);
    });
});
