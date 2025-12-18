import React from 'react';

interface TooltipProps {
  text: string;
  children: React.ReactNode;
}

export const Tooltip: React.FC<TooltipProps> = ({ text, children }) => {
  return (
    <div className="group relative flex items-center justify-center">
      {children}
      <div className="absolute bottom-full mb-2 hidden whitespace-nowrap rounded bg-gray-800 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:flex group-hover:opacity-100 border border-gray-700">
        {text}
      </div>
    </div>
  );
};
