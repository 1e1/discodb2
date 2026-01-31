from typing import Callable

import tkinter as tk
from tkinter import ttk

from app.ui.frame_table import build_frame_table


class DiffTab:
    def __init__(
        self,
        parent: ttk.Notebook,
        blob_toggle_var: tk.BooleanVar,
        minus_toggle_var: tk.BooleanVar,
        on_hold_capture: Callable,
        on_toggle_capture: Callable,
        on_reset: Callable,
        on_diff: Callable,
        on_name_edit: Callable,
    ) -> None:
        self.frame = ttk.Frame(parent, padding=12)

        self.frame.rowconfigure(0, weight=2)
        self.frame.rowconfigure(2, weight=3)
        self.frame.columnconfigure(0, weight=1)

        top_frame = ttk.Frame(self.frame)
        top_frame.grid(row=0, column=0, sticky="nsew")
        top_frame.columnconfigure(0, weight=1)
        top_frame.columnconfigure(1, weight=1)

        blob_frame = ttk.LabelFrame(top_frame, text="Blob", padding=8)
        blob_frame.grid(row=0, column=0, sticky="nsew", padx=(0, 8))
        blob_frame.columnconfigure(0, weight=1)
        blob_frame.columnconfigure(1, weight=1)

        blob_hold = ttk.Button(blob_frame, text="Hold Capture", padding=(4, 6))
        blob_hold.grid(row=0, column=0, sticky="ew", padx=(0, 4), pady=(0, 6))
        blob_hold.bind("<ButtonPress-1>", lambda event: on_hold_capture("blob", True))
        blob_hold.bind("<ButtonRelease-1>", lambda event: on_hold_capture("blob", False))

        blob_toggle = ttk.Checkbutton(
            blob_frame,
            text="Latch Capture",
            variable=blob_toggle_var,
            command=on_toggle_capture,
            padding=(4, 6),
        )
        blob_toggle.grid(row=0, column=1, sticky="ew", padx=(4, 0), pady=(0, 6))

        self.blob_status_label = ttk.Label(blob_frame, text="Idle", foreground="#666666")
        self.blob_status_label.grid(row=1, column=0, columnspan=2, sticky="w", pady=(0, 6))

        blob_table_frame = ttk.Frame(blob_frame)
        blob_table_frame.grid(row=2, column=0, columnspan=2, sticky="nsew")
        blob_frame.rowconfigure(2, weight=1)
        self.blob_tree, blob_scroll = build_frame_table(blob_table_frame, height=10)
        self.blob_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        blob_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.blob_tree.bind("<Double-1>", on_name_edit)

        minus_frame = ttk.LabelFrame(top_frame, text="Minus", padding=8)
        minus_frame.grid(row=0, column=1, sticky="nsew", padx=(8, 0))
        minus_frame.columnconfigure(0, weight=1)
        minus_frame.columnconfigure(1, weight=1)

        minus_hold = ttk.Button(minus_frame, text="Hold Capture", padding=(4, 6))
        minus_hold.grid(row=0, column=0, sticky="ew", padx=(0, 4), pady=(0, 6))
        minus_hold.bind("<ButtonPress-1>", lambda event: on_hold_capture("minus", True))
        minus_hold.bind("<ButtonRelease-1>", lambda event: on_hold_capture("minus", False))

        minus_toggle = ttk.Checkbutton(
            minus_frame,
            text="Latch Capture",
            variable=minus_toggle_var,
            command=on_toggle_capture,
            padding=(4, 6),
        )
        minus_toggle.grid(row=0, column=1, sticky="ew", padx=(4, 0), pady=(0, 6))

        self.minus_status_label = ttk.Label(minus_frame, text="Idle", foreground="#666666")
        self.minus_status_label.grid(row=1, column=0, columnspan=2, sticky="w", pady=(0, 6))

        minus_table_frame = ttk.Frame(minus_frame)
        minus_table_frame.grid(row=2, column=0, columnspan=2, sticky="nsew")
        minus_frame.rowconfigure(2, weight=1)
        self.minus_tree, minus_scroll = build_frame_table(minus_table_frame, height=10)
        self.minus_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        minus_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.minus_tree.bind("<Double-1>", on_name_edit)

        action_frame = ttk.Frame(self.frame)
        action_frame.grid(row=1, column=0, sticky="ew", pady=8)
        action_frame.columnconfigure(0, weight=1)
        action_frame.columnconfigure(1, weight=1)

        reset_button = ttk.Button(action_frame, text="Reset", command=on_reset)
        reset_button.grid(row=0, column=0, sticky="ew", padx=(0, 6))

        diff_button = ttk.Button(action_frame, text="Diff CAN ID", command=on_diff)
        diff_button.grid(row=0, column=1, sticky="ew", padx=(6, 0))

        render_frame = ttk.LabelFrame(self.frame, text="Diff Render", padding=8)
        render_frame.grid(row=2, column=0, sticky="nsew")
        render_frame.rowconfigure(0, weight=1)
        render_frame.columnconfigure(0, weight=1)

        diff_table_frame = ttk.Frame(render_frame)
        diff_table_frame.grid(row=0, column=0, sticky="nsew")
        self.diff_tree, diff_scroll = build_frame_table(diff_table_frame, height=12)
        self.diff_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        diff_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.diff_tree.bind("<Double-1>", on_name_edit)

