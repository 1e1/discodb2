from typing import Callable

import tkinter as tk
from tkinter import ttk


class DictionaryTab:
    def __init__(self, parent: ttk.Notebook, on_name_edit: Callable) -> None:
        self.frame = ttk.Frame(parent, padding=12)
        self.frame.rowconfigure(0, weight=1)
        self.frame.columnconfigure(0, weight=1)

        table_frame = ttk.Frame(self.frame)
        table_frame.grid(row=0, column=0, sticky="nsew")

        columns = ("id", "name")
        self.dictionary_tree = ttk.Treeview(table_frame, columns=columns, show="headings", height=20)
        self.dictionary_tree.heading("id", text="ID")
        self.dictionary_tree.heading("name", text="Name")

        self.dictionary_tree.column("id", width=120, anchor="center")
        self.dictionary_tree.column("name", width=300)

        self.dictionary_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.dictionary_tree.bind("<Double-1>", on_name_edit)

        scrollbar = ttk.Scrollbar(table_frame, orient=tk.VERTICAL, command=self.dictionary_tree.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.dictionary_tree.configure(yscrollcommand=scrollbar.set)

