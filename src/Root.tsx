import { useHashRoute } from './ui/useHashRoute.ts';
import App from './App.tsx';
import SpecPage from './spec/SpecPage.tsx';

/**
 * Route switch. Leaving the game route unmounts App, which tears down the
 * camera and the WASM graph — a webcam left running behind a documentation
 * page would be both a resource leak and a bad look.
 */
export default function Root() {
  const route = useHashRoute();
  return route.startsWith('/spec') ? <SpecPage /> : <App />;
}
