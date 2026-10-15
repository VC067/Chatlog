import React from "react";
import ReactDOM from "react-dom/client";
import App from "./Workspace.tsx";
import { Boundary } from "../../ui/Boundary.tsx";
import "./style.css";
const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </React.StrictMode>,
);
