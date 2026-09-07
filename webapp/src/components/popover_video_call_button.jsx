/* eslint-disable react/prop-types */
import React from 'react';
import PropTypes from 'prop-types';
import {connect} from 'react-redux';
import {bindActionCreators} from 'redux';

import {getCurrentUserId} from 'mattermost-redux/selectors/entities/users';

import {makeVideoCall} from '../actions';

class PopoverVideoCallButton extends React.PureComponent {
    static propTypes = {
        user_id: PropTypes.string,
        userId: PropTypes.string,
        hide: PropTypes.func,
        theme: PropTypes.object,
        makeVideoCall: PropTypes.func.isRequired,
        currentUserId: PropTypes.string,
    };

    startCall = (audioOnly) => () => {
        const {user_id: snake, userId: camel, hide, makeVideoCall: placeCall} = this.props;
        const targetId = camel || snake;
        if (hide) {
            hide();
        }
        if (targetId) {
            placeCall(targetId, {audioOnly});
        }
    };

    render() {
        const {user_id: snake, userId: camel, currentUserId, theme} = this.props;
        const targetId = camel || snake;
        if (!targetId || targetId === currentUserId) {
            return null;
        }

        const t = theme || {};
        const bg = t.buttonBg || '#166de0';
        const fg = t.buttonColor || '#fff';

        const buttonStyle = {
            flex: 1,
            backgroundColor: bg,
            borderColor: bg,
            color: fg,
        };

        return (
            <div style={{display: 'flex', gap: 8, marginTop: 12}}>
                <button
                    type='button'
                    className='btn btn-primary'
                    style={buttonStyle}
                    title='Start a voice call'
                    onClick={this.startCall(true)}
                >
                    <i
                        className='fa fa-phone'
                        style={{marginRight: 8}}
                    />
                    {'Voice'}
                </button>
                <button
                    type='button'
                    className='btn btn-primary'
                    style={buttonStyle}
                    title='Start a video call'
                    onClick={this.startCall(false)}
                >
                    <i
                        className='fa fa-video-camera'
                        style={{marginRight: 8}}
                    />
                    {'Video'}
                </button>
            </div>
        );
    }
}

const mapStateToProps = (state) => ({
    currentUserId: getCurrentUserId(state),
});

const mapDispatchToProps = (dispatch) => bindActionCreators({makeVideoCall}, dispatch);

export default connect(mapStateToProps, mapDispatchToProps)(PopoverVideoCallButton);
