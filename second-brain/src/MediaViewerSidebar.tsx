// ========== MediaViewerSidebar — full-res prikaz medija (KORAK 6) ==========
// Klizni panel desno (kao FileInspector) koji na klik MediaPreviewCard-a prikaže
// sliku/PDF/video u punoj rezoluciji. Fajl se servira preko /api/media (backend
// je Electron/HTTP zamena za Tauri convertFileSrc). 'X' zatvara.

export interface MediaTarget {
  path: string;
  kind: "image" | "pdf" | "video";
  name: string;
}

interface Props {
  media: MediaTarget | null;
  onClose: () => void;
}

export default function MediaViewerSidebar({ media, onClose }: Props) {
  const open = media !== null;
  const src = media ? `/api/media?path=${encodeURIComponent(media.path)}` : "";

  return (
    <aside className={`inspector inspector--media ${open ? "inspector--open" : ""}`} aria-hidden={!open}>
      <header className="inspector__head">
        <div className="inspector__titles">
          <span className="inspector__title">{media?.name ?? "Media"}</span>
          {media && <span className="inspector__path">{media.path}</span>}
        </div>
        <button className="inspector__close" onClick={onClose} aria-label="Zatvori" type="button">
          ×
        </button>
      </header>
      <div className="inspector__body inspector__body--media">
        {media?.kind === "image" && <img className="media-full" src={src} alt={media.name} />}
        {media?.kind === "pdf" && <embed className="media-full" src={src} type="application/pdf" />}
        {media?.kind === "video" && <video className="media-full" src={src} controls preload="metadata" />}
      </div>
    </aside>
  );
}
