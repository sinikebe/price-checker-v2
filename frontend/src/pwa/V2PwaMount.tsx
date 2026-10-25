import { useLocation } from "react-router-dom";
import PwaControls from "./PwaControls";

export default function V2PwaMount() {
  const { pathname } = useLocation();
  return pathname.startsWith("/v2") ? <PwaControls /> : null;
}
