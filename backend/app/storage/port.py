"""The object storage PORT — same idea as app/face/port.py, applied to files.

The system only knows "store / fetch / delete a file by key". Today the adapter speaks the
S3 protocol to SeaweedFS (the CESMAC server); if the institution ever changes storage, only
a new adapter is written.
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Protocol, runtime_checkable


@runtime_checkable
class ObjectStorage(Protocol):
    def ensure_bucket(self) -> None:
        """Create the private bucket if it does not exist yet."""
        ...

    def put(self, key: str, data: bytes, content_type: str) -> None: ...

    def put_file(self, key: str, path: str, content_type: str) -> None:
        """Streams a file from disk in parts — for large objects (a 1.000-photo package can
        exceed 10 GB and must never be loaded into memory)."""
        ...

    def get(self, key: str) -> bytes: ...

    def get_file(self, key: str, path: str) -> None:
        """Writes an object to a file on disk, in parts: a video never goes whole into memory."""
        ...

    def exists(self, key: str) -> bool: ...

    def delete(self, key: str) -> None:
        """Delete the object. Must succeed silently if it is already gone (idempotent),
        so a retried deletion job never fails half-way."""
        ...

    def stream(self, key: str, chunk_size: int = 1024 * 1024) -> tuple[int, Iterator[bytes]]:
        """(size, chunks) of an object, read piece by piece — for large files (a package) that
        must reach the browser without ever being loaded whole into memory.

        There is deliberately NO "signed link to the storage": every file reaches the browser
        through the API, which checks the session first. The storage address never leaves the
        server."""
        ...

    def stream_range(self, key: str, start: int, end: int, chunk_size: int = 1024 * 1024) -> Iterator[bytes]:
        """The bytes from start to end, both included: a video plays in parts, without the whole file (RF034)."""
        ...
