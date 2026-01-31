from typing import Callable, List

import tkinter as tk
from tkinter import ttk

from app.ui.frame_table import build_frame_table


class LiveTab:
    def __init__(
        self,
        parent: ttk.Notebook,
        serial_port_var: tk.StringVar,
        on_select: Callable,
        on_name_edit: Callable,
        on_toggle_serial: Callable,
        on_refresh_serial: Callable,
        on_send_serial: Callable,
    ) -> None:
        self.frame = ttk.Frame(parent, padding=12)
        self.serial_port_var = serial_port_var

        self.frame.rowconfigure(0, weight=1)
        self.frame.columnconfigure(0, weight=3)
        self.frame.columnconfigure(1, weight=2)

        table_frame = ttk.Frame(self.frame)
        table_frame.grid(row=0, column=0, sticky="nsew", padx=(0, 12))

        self.tree, scrollbar = build_frame_table(table_frame, height=22)
        self.tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.tree.bind("<<TreeviewSelect>>", on_select)
        self.tree.bind("<Double-1>", on_name_edit)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        inspector_frame = ttk.LabelFrame(self.frame, text="Inspector", padding=12)
        inspector_frame.grid(row=0, column=1, sticky="nsew")
        inspector_frame.columnconfigure(0, weight=1)

        self.inspector_title = ttk.Label(inspector_frame, text="Select a frame to inspect.")
        self.inspector_title.grid(row=0, column=0, sticky=tk.W, pady=(0, 8))

        self.byte_frame = ttk.Frame(inspector_frame)
        self.byte_frame.grid(row=1, column=0, sticky="ew", pady=(0, 12))

        self.byte_labels: List[tk.Label] = []
        for i in range(8):
            label = tk.Label(
                self.byte_frame,
                text="--",
                width=4,
                relief=tk.RIDGE,
                borderwidth=1,
                bg="#f5f5f5",
            )
            label.grid(row=0, column=i, padx=2, pady=2)
            self.byte_labels.append(label)

        ttk.Label(inspector_frame, text="Payload history (most recent first):").grid(
            row=2, column=0, sticky=tk.W
        )
        self.history_list = tk.Listbox(inspector_frame, height=12)
        self.history_list.grid(row=3, column=0, sticky="nsew", pady=(4, 0))

        self._build_serial_console(inspector_frame, on_toggle_serial, on_refresh_serial, on_send_serial)

    def _build_serial_console(
        self,
        parent: ttk.Frame,
        on_toggle_serial: Callable,
        on_refresh_serial: Callable,
        on_send_serial: Callable,
    ) -> None:
        console_frame = ttk.LabelFrame(parent, text="Serial Console", padding=8)
        console_frame.grid(row=4, column=0, sticky="nsew", pady=(12, 0))
        console_frame.columnconfigure(1, weight=1)

        ttk.Label(console_frame, text="Port:").grid(row=0, column=0, sticky=tk.W)
        self.serial_combo = ttk.Combobox(
            console_frame,
            textvariable=self.serial_port_var,
            state="readonly",
            width=28,
        )
        self.serial_combo.grid(row=0, column=1, sticky="ew", padx=4)

        self.serial_connect_button = ttk.Button(
            console_frame, text="Connect", command=on_toggle_serial
        )
        self.serial_connect_button.grid(row=0, column=2, padx=4)

        refresh_button = ttk.Button(console_frame, text="Refresh", command=on_refresh_serial)
        refresh_button.grid(row=0, column=3, padx=4)

        self.serial_output = tk.Text(
            console_frame, height=6, wrap=tk.WORD, state=tk.DISABLED
        )
        self.serial_output.grid(row=1, column=0, columnspan=4, sticky="nsew", pady=(6, 4))

        entry_frame = ttk.Frame(console_frame)
        entry_frame.grid(row=2, column=0, columnspan=4, sticky="ew")
        entry_frame.columnconfigure(0, weight=1)

        self.serial_entry = ttk.Entry(entry_frame)
        self.serial_entry.grid(row=0, column=0, sticky="ew", padx=(0, 4))
        self.serial_entry.bind("<Return>", on_send_serial)

        send_button = ttk.Button(entry_frame, text="Send", command=on_send_serial)
        send_button.grid(row=0, column=1)

