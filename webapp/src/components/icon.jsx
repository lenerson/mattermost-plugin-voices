import React from 'react';

import {makeStyleFromTheme} from 'mattermost-redux/utils/theme_utils';

import {Svgs} from '../constants';

// One box for every glyph, so icons of different intrinsic sizes (the camera is
// 14x10, the handset 14x14) still land on the same centre.
const GLYPH_BOX_PX = 16;

/**
 * The registry takes an element, not a component, so each icon is exported
 * already rendered.
 */
class Glyph extends React.PureComponent {
    render() {
        const style = getStyle();

        return (
            <span
                style={style.iconStyle}
                aria-hidden='true'
                dangerouslySetInnerHTML={{__html: this.props.svg}} // eslint-disable-line react/prop-types
            />
        );
    }
}

const getStyle = makeStyleFromTheme(() => {
    return {

        /*
         * The channel header drops this into a round icon button. An inline
         * span sits its SVG on the text baseline, which is what pushed the
         * glyphs off centre — a fixed flex box centres them on both axes
         * instead, with no per-icon nudging.
         */
        iconStyle: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: GLYPH_BOX_PX,
            height: GLYPH_BOX_PX,
            lineHeight: 1,
            verticalAlign: 'middle',
        },
    };
});

export const PhoneIcon = <Glyph svg={Svgs.PHONE}/>;

const VideoIcon = <Glyph svg={Svgs.VIDEO_CAMERA}/>;

export default VideoIcon;
