import General from 'mattermost-redux/constants/general';
import {getCurrentUser} from 'mattermost-redux/selectors/entities/users';

/**
 * Other user's id in a 1:1 direct message channel.
 * Mattermost desktop/web often omits `channel.teammate_id`; DM `channel.name` is two ids sorted, joined by "__".
 */
export function getDirectMessagePeerUserId(state, channel) {
    if (!channel) {
        return null;
    }

    const me = getCurrentUser(state);
    const myId = me && me.id;

    /*
     * Mattermost lets you open a DM with yourself. That channel has no peer to
     * call, and it is named `id__id`, so both halves of the split match and the
     * plugin would happily ring itself — a call that can never connect.
     */
    if (channel.teammate_id) {
        return channel.teammate_id === myId ? null : channel.teammate_id;
    }
    if (channel.type !== General.DM_CHANNEL) {
        return null;
    }
    if (!myId || !channel.name) {
        return null;
    }
    const ids = channel.name.split('__');
    if (ids.length !== 2) {
        return null;
    }
    const [a, b] = ids;
    if (a === b) {
        return null;
    }
    if (a === myId) {
        return b;
    }
    if (b === myId) {
        return a;
    }
    return null;
}
