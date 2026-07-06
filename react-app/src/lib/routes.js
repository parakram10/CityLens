// Ward codes can contain a literal "/" (e.g. "G/N", "K/W", "R/C"), which would
// otherwise split into an extra path segment inside /ward/:wardId. Encode on the
// way in — react-router's useParams() decodes it back automatically on the way out.
export const wardPath = ward => `/ward/${encodeURIComponent(ward)}`;
