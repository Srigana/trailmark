import type { ApiError } from '../api';

export function Loading() {
  return <p className="loading">Loading</p>;
}

export function ErrorNote({ error }: { error: ApiError }) {
  return (
    <p className="alert" role="alert">
      {error.message}
    </p>
  );
}
