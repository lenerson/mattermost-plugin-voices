/* eslint-disable react/prop-types */
import React from 'react';
import PropTypes from 'prop-types';
import {connect} from 'react-redux';

import {getCurrentUserId} from 'mattermost-redux/selectors/entities/users';

import {
    VOICE_INVITE_ACCEPTED,
    VOICE_INVITE_DECLINED,
    VOICE_INVITE_PENDING,
    VOICE_INVITE_PROPS_KEY,
} from '../../constants/voiceInvite';
import {emitVoiceInviteDecision} from '../../utils/voiceInviteEvents';
import {respondVoiceRoomInvite} from '../../utils/voiceInvitesApi';

export function parseVoiceInvite(post) {
    if (!post || !post.props) {
        return null;
    }
    let invite = post.props[VOICE_INVITE_PROPS_KEY];
    if (typeof invite === 'string') {
        try {
            invite = JSON.parse(invite);
        } catch (error) {
            return null;
        }
    }
    return invite && typeof invite === 'object' ? invite : null;
}

export class VoiceInvitePost extends React.PureComponent {
    static propTypes = {
        post: PropTypes.object.isRequired,
        theme: PropTypes.object,
        currentUserId: PropTypes.string,
    };

    state = {
        submitting: false,
        localStatus: '',
        localInviteId: '',
        error: '',
        expiredInviteId: '',
    };

    expiryTimer = null;

    componentDidMount() {
        this.scheduleExpiry();
    }

    componentDidUpdate(previousProps) {
        const previous = parseVoiceInvite(previousProps.post);
        const current = parseVoiceInvite(this.props.post);
        if (!previous || !current || previous.inviteId !== current.inviteId || previous.expiresAt !== current.expiresAt || previous.status !== current.status) {
            this.scheduleExpiry();
        }
    }

    componentWillUnmount() {
        this.clearExpiryTimer();
    }

    clearExpiryTimer() {
        if (this.expiryTimer) {
            clearTimeout(this.expiryTimer);
            this.expiryTimer = null;
        }
    }

    scheduleExpiry() {
        this.clearExpiryTimer();
        const invite = parseVoiceInvite(this.props.post);
        if (!invite || invite.status !== VOICE_INVITE_PENDING) {
            return;
        }
        const delay = Number(invite.expiresAt) - Date.now();
        if (!Number.isFinite(delay) || delay <= 0) {
            this.setState({expiredInviteId: invite.inviteId});
            return;
        }
        this.expiryTimer = setTimeout(() => {
            this.expiryTimer = null;
            this.setState({expiredInviteId: invite.inviteId});
        }, delay);
    }

    handleDecision = (decision) => (event) => {
        event.preventDefault();
        const {post} = this.props;
        const invite = parseVoiceInvite(post);
        if (!invite || this.state.expiredInviteId === invite.inviteId || Number(invite.expiresAt) <= Date.now()) {
            this.setState({expiredInviteId: invite && invite.inviteId});
            return null;
        }

        this.setState({submitting: true, error: ''});
        return respondVoiceRoomInvite(post.id, invite.inviteId, decision).
            then(() => {
                this.clearExpiryTimer();
                this.setState({submitting: false, localStatus: decision, localInviteId: invite.inviteId});
                emitVoiceInviteDecision({...invite, postId: post.id}, decision);
            }).
            catch(() => {
                this.setState({submitting: false, error: 'Could not answer this invitation.'});
            });
    };

    render() {
        const {post, currentUserId, theme} = this.props;
        const invite = parseVoiceInvite(post);
        if (!invite || !invite.inviteId || !invite.roomName || !invite.targetUserId) {
            return null;
        }

        const localStatus = this.state.localInviteId === invite.inviteId ? this.state.localStatus : '';
        const status = localStatus || invite.status || VOICE_INVITE_PENDING;
        const expired = this.state.expiredInviteId === invite.inviteId || (status === VOICE_INVITE_PENDING && Number(invite.expiresAt) <= Date.now());
        const canRespond = currentUserId === invite.targetUserId && status === VOICE_INVITE_PENDING && !expired;
        const colors = theme || {};
        const border = colors.centerChannelColor || '#333';
        const background = colors.centerChannelBg || '#fff';
        let statusText = 'Waiting for a response.';
        if (expired) {
            statusText = 'This invitation has expired.';
        } else if (status === VOICE_INVITE_ACCEPTED) {
            statusText = 'Invitation accepted.';
        } else if (status === VOICE_INVITE_DECLINED) {
            statusText = 'Invitation declined.';
        }

        return (
            <div
                className='webrtc-voice-invite-post'
                style={{marginTop: 8, padding: 12, maxWidth: 420, border: `1px solid ${border}33`, borderRadius: 6, backgroundColor: `${background}f5`}}
            >
                <div style={{fontWeight: 600}}>{'Voice channel invitation'}</div>
                <div style={{marginTop: 4}}>{`Join ${invite.roomName}?`}</div>
                {canRespond && (
                    <div style={{display: 'flex', gap: 8, marginTop: 10}}>
                        <button
                            type='button'
                            disabled={this.state.submitting}
                            onClick={this.handleDecision(VOICE_INVITE_ACCEPTED)}
                            style={{padding: '6px 12px', border: 'none', borderRadius: 4, background: '#166de0', color: '#fff', fontWeight: 600}}
                        >
                            {'Accept'}
                        </button>
                        <button
                            type='button'
                            disabled={this.state.submitting}
                            onClick={this.handleDecision(VOICE_INVITE_DECLINED)}
                            style={{padding: '6px 12px', border: `1px solid ${border}55`, borderRadius: 4, background: 'transparent'}}
                        >
                            {'Decline'}
                        </button>
                    </div>
                )}
                {!canRespond && <div style={{marginTop: 8, fontSize: '0.88em'}}>{statusText}</div>}
                {this.state.error && <div style={{marginTop: 8, color: '#d24b4b'}}>{this.state.error}</div>}
            </div>
        );
    }
}

const mapStateToProps = (state) => ({
    currentUserId: getCurrentUserId(state),
});

export default connect(mapStateToProps)(VoiceInvitePost);
