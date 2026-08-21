/**
 * Two routes do not justify a router.
 *
 * Spec §21 rules out additional heavy dependencies without a demonstrated
 * requirement, and hash routing needs no server configuration either — which
 * matters if this is ever served from a static host under a subpath.
 */
import { useEffect, useState } from 'react';

const currentRoute = () => window.location.hash.replace(/^#/, '') || '/';

export function useHashRoute(): string {
  const [route, setRoute] = useState(currentRoute);

  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

export function navigate(route: string): void {
  window.location.hash = route;
}
