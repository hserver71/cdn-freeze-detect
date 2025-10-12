import React, { useState, useMemo } from "react";

const SmartTable = ({ data }) => {
    const [search, setSearch] = useState("");
    const [sortConfig, setSortConfig] = useState({ key: null, direction: "asc" });
    const [page, setPage] = useState(1);
    const rowsPerPage = 5;

    const handleSort = (key) => {
        setSortConfig((prev) => ({
            key,
            direction: prev.direction === "asc" ? "desc" : "asc"
        }));
    };

    const filteredData = useMemo(() => {
        return data.filter((item) =>
            Object.values(item)
                .join(" ")
                .toLowerCase()
                .includes(search.toLowerCase())
        );
    }, [data, search]);

    const sortedData = useMemo(() => {
        if (!sortConfig.key) return filteredData;

        return [...filteredData].sort((a, b) => {
            const valA = a[sortConfig.key];
            const valB = b[sortConfig.key];

            if (valA < valB) return sortConfig.direction === "asc" ? -1 : 1;
            if (valA > valB) return sortConfig.direction === "asc" ? 1 : -1;
            return 0;
        });
    }, [filteredData, sortConfig]);

    const paginatedData = useMemo(() => {
        const start = (page - 1) * rowsPerPage;
        return sortedData.slice(start, start + rowsPerPage);
    }, [sortedData, page]);

    return (
        <div style={{ maxWidth: "600px", margin: "20px auto" }}>
            <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={(e) => {
                    setPage(1); // reset page on new search
                    setSearch(e.target.value);
                }}
                style={{ marginBottom: "10px", width: "100%", padding: "8px" }}
            />

            <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                    <tr>
                        {Object.keys(data[0]).map((key) => (
                            <th
                                key={key}
                                onClick={() => handleSort(key)}
                                style={{
                                    cursor: "pointer",
                                    borderBottom: "1px solid #ccc",
                                    padding: "8px",
                                    textAlign: "left"
                                }}
                            >
                                {key.toUpperCase()}
                                {sortConfig.key === key ? (
                                    sortConfig.direction === "asc" ? " ▲" : " ▼"
                                ) : null}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {paginatedData.length ? (
                        paginatedData.map((row, i) => (
                            <tr key={i}>
                                {Object.values(row).map((value, j) => (
                                    <td
                                        key={j}
                                        style={{
                                            padding: "8px",
                                            borderBottom: "1px solid #eee"
                                        }}
                                    >
                                        {value}
                                    </td>
                                ))}
                            </tr>
                        ))
                    ) : (
                        <tr>
                            <td colSpan={Object.keys(data[0]).length} style={{ padding: "10px", textAlign: "center" }}>
                                No results found
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>

            <div style={{ marginTop: "10px", display: "flex", justifyContent: "space-between" }}>
                <button
                    disabled={page === 1}
                    onClick={() => setPage((p) => p - 1)}
                >
                    Prev
                </button>
                <span>Page {page}</span>
                <button
                    disabled={page * rowsPerPage >= sortedData.length}
                    onClick={() => setPage((p) => p + 1)}
                >
                    Next
                </button>
            </div>
        </div>
    );
};

export default SmartTable;