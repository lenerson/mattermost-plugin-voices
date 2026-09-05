import {getCurrentUser} from 'mattermost-redux/selectors/entities/users';

import {getDirectMessagePeerUserId} from './dmPeer';

jest.mock('mattermost-redux/selectors/entities/users', () => ({
    getCurrentUser: jest.fn(),
}));

const ME = 'me11111111111111111111111';
const OTHER = 'you2222222222222222222222';
const STATE = {};

// Only the type matters to the code under test; General.DM_CHANNEL is 'D'.
const dm = (name, extra = {}) => ({type: 'D', name, ...extra});

describe('getDirectMessagePeerUserId', () => {
    beforeEach(() => {
        getCurrentUser.mockReturnValue({id: ME});
    });

    test('finds the other person in a normal DM', () => {
        expect(getDirectMessagePeerUserId(STATE, dm(`${ME}__${OTHER}`))).toBe(OTHER);
        expect(getDirectMessagePeerUserId(STATE, dm(`${OTHER}__${ME}`))).toBe(OTHER);
    });

    test('prefers teammate_id when Mattermost supplies it', () => {
        expect(getDirectMessagePeerUserId(STATE, dm('whatever', {teammate_id: OTHER}))).toBe(OTHER);
    });

    /*
     * Mattermost lets you open a DM with yourself. Its name is `id__id`, so
     * both halves match and the old code handed back your own id — which let
     * the plugin ring itself into a call that could never connect.
     */
    test('a self-DM has no peer, by name', () => {
        expect(getDirectMessagePeerUserId(STATE, dm(`${ME}__${ME}`))).toBeNull();
    });

    test('a self-DM has no peer, by teammate_id', () => {
        expect(getDirectMessagePeerUserId(STATE, dm(`${ME}__${ME}`, {teammate_id: ME}))).toBeNull();
    });

    test.each([
        ['no channel', null],
        ['a group channel', {type: 'G', name: 'group-channel'}],
        ['a public channel', {type: 'O', name: 'town-square'}],
        ['a malformed DM name', dm('not-a-pair')],
        ['a DM we are not part of', dm('aaa__bbb')],
    ])('returns null for %s', (_label, channel) => {
        expect(getDirectMessagePeerUserId(STATE, channel)).toBeNull();
    });

    test('returns null when the current user is not loaded yet', () => {
        getCurrentUser.mockReturnValue(null);

        expect(getDirectMessagePeerUserId(STATE, dm(`${ME}__${OTHER}`))).toBeNull();
    });
});
