import json
from typing import Dict


def encode_dictionary(id_names: Dict[int, str]) -> Dict[str, str]:
    return {f"{key:03X}": value for key, value in id_names.items()}


def decode_dictionary(payload: object) -> Dict[int, str]:
    if not isinstance(payload, dict):
        return {}
    result: Dict[int, str] = {}
    for key, value in payload.items():
        if not isinstance(value, str):
            continue
        try:
            arbitration_id = int(str(key), 16)
        except ValueError:
            continue
        if value.strip():
            result[arbitration_id] = value.strip()
    return result


def load_dictionary(path: str) -> Dict[int, str]:
    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return decode_dictionary(payload)


def save_dictionary(path: str, id_names: Dict[int, str]) -> None:
    payload = encode_dictionary(id_names)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)

