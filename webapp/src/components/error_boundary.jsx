import React from 'react';
import PropTypes from 'prop-types';

import debug from '../utils/debug';

/**
 * Mattermost renders plugin components inside its own React tree without a
 * boundary of its own, so an uncaught render error here blanks the whole
 * webapp. Every component handed to the registry goes through this wrapper:
 * worst case the plugin disappears, never the app.
 */
export default class PluginErrorBoundary extends React.PureComponent {
    static propTypes = {
        label: PropTypes.string,
        children: PropTypes.node,
    };

    constructor(props) {
        super(props);
        this.state = {failed: false};
    }

    static getDerivedStateFromError() {
        return {failed: true};
    }

    componentDidCatch(error, info) {
        const label = this.props.label || 'component';
        debug(`[error_boundary] ${label} crashed`, error, info);
    }

    render() {
        if (this.state.failed) {
            return null;
        }
        return this.props.children;
    }
}
