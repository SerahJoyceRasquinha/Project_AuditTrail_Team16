import { Component } from 'react';

/**
 * Catches render-time crashes so one broken panel cannot take the whole
 * dashboard down with it. A forensic tool that goes blank during an
 * investigation is worse than one that shows a degraded panel.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Dashboard panel crashed:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="panel">
          <div className="state-block state-block--error" role="alert">
            <div className="state-block__title">This panel stopped working</div>
            <p style={{ margin: '0 0 12px' }}>{this.state.error.message}</p>
            <button type="button" className="btn btn--sm" onClick={() => this.setState({ error: null })}>
              Reload panel
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
