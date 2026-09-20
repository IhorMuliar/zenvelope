import { useEffect, useState } from "react";
import { Create } from "./pages/Create";
import { Open } from "./pages/Open";
import { How } from "./pages/How";

function currentPath(): string {
  return window.location.pathname.replace(/\/+$/, "") || "/";
}

export function App() {
  const [path, setPath] = useState(currentPath());

  useEffect(() => {
    const onPop = () => setPath(currentPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = (to: string) => {
    window.history.pushState({}, "", to);
    setPath(currentPath());
  };

  const link = (to: string, label: string) => (
    <a
      href={to}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {label}
    </a>
  );

  return (
    <div className="shell">
      <header className="site-header">
        <a
          className="wordmark"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          Zenvelope
        </a>
        <nav>
          {link("/how", "How it works")}
          <a href="https://github.com/IhorMuliar/zenvelope" rel="noreferrer noopener">
            Source
          </a>
        </nav>
      </header>

      <main>
        {path === "/e" ? <Open /> : path === "/how" ? <How /> : <Create />}
      </main>

      <footer className="site-footer">
        <p>
          Static site. No accounts, no analytics, no server-side keys. The link fragment
          never reaches our server.
        </p>
      </footer>
    </div>
  );
}
