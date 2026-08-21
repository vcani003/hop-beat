import { useHashRoute } from './ui/useHashRoute.ts';
import App from './App.tsx';
import PlayScreen from './ui/PlayScreen.tsx';
import SpecPage from './spec/SpecPage.tsx';

/**
 * Route switch. Leaving a route unmounts it, which tears down the camera and
 * the WASM graph — a webcam left running behind a documentation page would be
 * both a resource leak and a bad look.
 *
 * The game is the front door now; MVP 0's instrumented view lives at /debug and
 * is still the place to answer "is the controller behaving?".
 */
export default function Root() {
  const route = useHashRoute();
  if (route.startsWith('/spec')) return <SpecPage />;
  if (route.startsWith('/debug')) return <App />;
  return <PlayScreen />;
}
