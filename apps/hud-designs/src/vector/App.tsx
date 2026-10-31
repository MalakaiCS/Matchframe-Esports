import { useHud } from "../shared/useHud.ts";

export default function App() {
  const { state } = useHud();
  return <div>{state ? `${state.left.name} ${state.left.score ?? 0} : ${state.right.score ?? 0} ${state.right.name}` : "waiting"}</div>;
}
