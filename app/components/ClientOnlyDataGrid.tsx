import React, { useState, useEffect } from "react";
import { DataGrid, type GridColDef, type GridRowsProp } from "@mui/x-data-grid";
import { Box, CircularProgress } from "@mui/material";

interface ClientOnlyDataGridProps {
  rows: GridRowsProp;
  columns: GridColDef[];
  [key: string]: any; // Allow other DataGrid props
}

export const ClientOnlyDataGrid: React.FC<ClientOnlyDataGridProps> = ({
  rows,
  columns,
  ...otherProps
}) => {
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  if (!isClient) {
    return (
      <Box
        sx={{
          height: 600,
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  return <DataGrid rows={rows} columns={columns} {...otherProps} />;
};
