import React from 'react';

import PluginErrorBoundary from './error_boundary';

/**
 * Wrap a component before handing it to the Mattermost plugin registry, so a
 * crash inside it takes down the plugin's own UI and nothing else.
 */
export function withErrorBoundary(WrappedComponent, label) {
    class Guarded extends React.PureComponent {
        render() {
            return (
                <PluginErrorBoundary label={label}>
                    <WrappedComponent {...this.props}/>
                </PluginErrorBoundary>
            );
        }
    }

    Guarded.displayName = `withErrorBoundary(${label})`;
    return Guarded;
}
