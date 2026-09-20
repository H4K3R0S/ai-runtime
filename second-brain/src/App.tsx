import { useCallback, useState } from "react";

import ApprovalCard from "./ApprovalCard";
import FileInspectorSidebar from "./FileInspectorSidebar";
import InfiniteCanvasWorkspace from "./InfiniteCanvasWorkspace";
import MediaViewerSidebar, { type MediaTarget } from "./MediaViewerSidebar";
import OrbitalSecondBrain, { type OrbitalInspectTarget } from "./OrbitalSecondBrain";
import RegionsView from "./RegionsView";
import RoutePulse from "./RoutePulse";
import "./App.css";

type View = "orbital" | "regions" | "canvas";

const SUBTITLE: Record<View, string> = {
  orbital: "Orbitalni ARMS prikaz",
  regions: "Regioni znanja",
  canvas: "Infinite Canvas",
};

export default function App() {
  const [inspected, setInspected] = useState<OrbitalInspectTarget | null>(null);
  const [media, setMedia] = useState<MediaTarget | null>(null);
  const [view, setView] = useState<View>("orbital");

  const onMaximizeMedia = useCallback((m: MediaTarget) => setMedia(m), []);

  return (
    <div className="app-root">
      <header className="app-header">
        <span className="app-title">AI OS · Second Brain</span>
        <span className="app-sub">{SUBTITLE[view]}</span>
        <RoutePulse />
        <div className="app-tabs">
          <button
            className={`app-tab ${view === "orbital" ? "is-active" : ""}`}
            onClick={() => setView("orbital")}
            type="button"
          >
            Orbita
          </button>
          <button
            className={`app-tab ${view === "regions" ? "is-active" : ""}`}
            onClick={() => setView("regions")}
            type="button"
          >
            Regioni
          </button>
          <button
            className={`app-tab ${view === "canvas" ? "is-active" : ""}`}
            onClick={() => setView("canvas")}
            type="button"
          >
            Kanvas
          </button>
        </div>
      </header>
      <main className="app-stage">
        {view === "orbital" && (
          <>
            <OrbitalSecondBrain onInspect={setInspected} />
            <FileInspectorSidebar atom={inspected} onClose={() => setInspected(null)} />
          </>
        )}
        {view === "regions" && (
          <>
            <RegionsView onInspect={setInspected} />
            <FileInspectorSidebar atom={inspected} onClose={() => setInspected(null)} />
          </>
        )}
        {view === "canvas" && (
          <>
            <InfiniteCanvasWorkspace onMaximizeMedia={onMaximizeMedia} />
            <MediaViewerSidebar media={media} onClose={() => setMedia(null)} />
          </>
        )}
      </main>
      <ApprovalCard />
    </div>
  );
}
