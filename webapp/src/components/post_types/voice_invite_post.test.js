jest.mock('manifest', () => ({id: 'mattermost-webrtc-video'}), {virtual: true});

import {
    VOICE_INVITE_ACCEPTED,
    VOICE_INVITE_PENDING,
    VOICE_INVITE_PROPS_KEY,
} from '../../constants/voiceInvite';
import {subscribeVoiceInviteDecisions} from '../../utils/voiceInviteEvents';
import {respondVoiceRoomInvite} from '../../utils/voiceInvitesApi';

import {parseVoiceInvite, VoiceInvitePost} from './voice_invite_post';

jest.mock('../../utils/voiceInvitesApi', () => ({
    respondVoiceRoomInvite: jest.fn(),
}));

const INVITE_TTL_MS = 5 * 60 * 1000;

function invitePost(overrides = {}) {
    return {
        id: 'post-1',
        props: {
            [VOICE_INVITE_PROPS_KEY]: {
                inviteId: 'invite-1',
                roomId: 'room-1',
                roomName: 'Standup',
                inviterId: 'user-1',
                targetUserId: 'user-2',
                expiresAt: Date.now() + INVITE_TTL_MS,
                status: VOICE_INVITE_PENDING,
                ...overrides,
            },
        },
    };
}

function applyStateSynchronously(component) {
    component.setState = (update) => {
        const nextState = typeof update === 'function' ? update(component.state) : update;
        component.state = {...component.state, ...nextState};
    };
}

function findElements(node, predicate, matches = []) {
    if (Array.isArray(node)) {
        node.forEach((child) => findElements(child, predicate, matches));
        return matches;
    }
    if (!node || typeof node !== 'object') {
        return matches;
    }
    if (predicate(node)) {
        matches.push(node);
    }
    findElements(node.props && node.props.children, predicate, matches);
    return matches;
}

function hasText(text) {
    return (element) => element.props && element.props.children === text;
}

function isButton(element) {
    return element.type === 'button';
}

describe('VoiceInvitePost', () => {
    beforeEach(() => {
        respondVoiceRoomInvite.mockReset();
    });

    test('parses both object and JSON-string invitation props', () => {
        const post = invitePost();
        expect(parseVoiceInvite(post)).toEqual(expect.objectContaining({inviteId: 'invite-1'}));
        post.props[VOICE_INVITE_PROPS_KEY] = JSON.stringify(post.props[VOICE_INVITE_PROPS_KEY]);
        expect(parseVoiceInvite(post)).toEqual(expect.objectContaining({roomId: 'room-1'}));
    });

    test('lets only the invited user accept or decline an active invitation', () => {
        const target = new VoiceInvitePost({post: invitePost(), currentUserId: 'user-2'});
        const sender = new VoiceInvitePost({post: invitePost(), currentUserId: 'user-1'});

        expect(findElements(target.render(), isButton)).toHaveLength(2);
        expect(findElements(sender.render(), isButton)).toHaveLength(0);
        expect(findElements(sender.render(), hasText('Waiting for a response.'))).toHaveLength(1);
    });

    test('persists acceptance and asks the voice panel to join', async () => {
        const post = invitePost();
        const component = new VoiceInvitePost({post, currentUserId: 'user-2'});
        applyStateSynchronously(component);
        respondVoiceRoomInvite.mockResolvedValue();
        const listener = jest.fn();
        const unsubscribe = subscribeVoiceInviteDecisions(listener);

        await component.handleDecision(VOICE_INVITE_ACCEPTED)({preventDefault: jest.fn()});

        expect(respondVoiceRoomInvite).toHaveBeenCalledWith('post-1', 'invite-1', VOICE_INVITE_ACCEPTED);
        expect(listener).toHaveBeenCalledWith({
            invite: expect.objectContaining({inviteId: 'invite-1', postId: 'post-1'}),
            decision: VOICE_INVITE_ACCEPTED,
        });
        expect(findElements(component.render(), hasText('Invitation accepted.'))).toHaveLength(1);
        unsubscribe();
    });

    test('renders an expired invitation without response buttons', () => {
        const component = new VoiceInvitePost({
            post: invitePost({expiresAt: Date.now() - 1}),
            currentUserId: 'user-2',
        });

        expect(findElements(component.render(), isButton)).toHaveLength(0);
        expect(findElements(component.render(), hasText('This invitation has expired.'))).toHaveLength(1);
    });
});
