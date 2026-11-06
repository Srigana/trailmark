import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <main className="page narrow">
      <h1>Page not found</h1>
      <p>
        <Link to="/">Go to the sources report</Link>
      </p>
    </main>
  );
}
