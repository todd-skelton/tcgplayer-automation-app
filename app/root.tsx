import { Outlet } from "react-router";

// The Corten app (`src/`) draws every screen; this app answers only its JSON routes (`routes.ts`).
export default function App() {
  return <Outlet />;
}
