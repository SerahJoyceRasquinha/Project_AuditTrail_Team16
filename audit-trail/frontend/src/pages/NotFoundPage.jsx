import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="panel">
      <div className="state-block">
        <div className="state-block__title">No such page</div>
        <p>That route does not exist in the dashboard.</p>
        <Link className="btn btn--sm" to="/">
          Go to shipments
        </Link>
      </div>
    </div>
  );
}
