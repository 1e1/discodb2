from typing import Tuple

from tkinter import ttk

from app.config import FRAME_COLUMNS


def build_frame_table(parent: ttk.Frame, height: int = 12) -> Tuple[ttk.Treeview, ttk.Scrollbar]:
    tree = ttk.Treeview(parent, columns=FRAME_COLUMNS, show="headings", height=height)
    tree.heading("id", text="ID")
    tree.heading("name", text="Name")
    tree.heading("dlc", text="DLC")
    tree.heading("data", text="Data (hex)")
    tree.heading("ascii", text="ASCII")
    tree.heading("count", text="Count")
    tree.heading("rate", text="Rate/s")
    tree.heading("last_seen", text="Last Seen")

    tree.column("id", width=80, anchor="center")
    tree.column("name", width=140)
    tree.column("dlc", width=50, anchor="center")
    tree.column("data", width=240)
    tree.column("ascii", width=120)
    tree.column("count", width=70, anchor="e")
    tree.column("rate", width=80, anchor="e")
    tree.column("last_seen", width=90, anchor="e")

    scrollbar = ttk.Scrollbar(parent, orient="vertical", command=tree.yview)
    tree.configure(yscrollcommand=scrollbar.set)
    return tree, scrollbar

