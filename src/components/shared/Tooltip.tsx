import React from 'react';

interface TooltipProps {
  text: string;
  children: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

export const Tooltip: React.FC<TooltipProps> = ({ 
  text, 
  children, 
  position = 'top' 
}) => {
  const positionClasses = {
    top: 'bottom-full mb-2 left-1/2 -translate-x-1/2',
    bottom: 'top-full mt-2 left-1/2 -translate-x-1/2',
    left: 'right-full mr-2 top-1/2 -translate-y-1/2',
    right: 'left-full ml-2 top-1/2 -translate-y-1/2'
  };

  return (
    <div className="group relative flex items-center justify-center">
      {children}
      <div 
        className={`absolute ${positionClasses[position]} hidden whitespace-nowrap rounded bg-gray-800 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:flex group-hover:opacity-100 border border-gray-700 z-50`}
      >
        {text}
        <div 
          className={`absolute ${position === 'top' ? 'top-full' : position === 'bottom' ? 'bottom-full' : 'left-full'} ${position === 'top' || position === 'bottom' ? 'left-1/2 -translate-x-1/2' : 'top-1/2 -translate-y-1/2'} border-4 border-transparent ${position === 'top' ? 'border-t-gray-800' : position === 'bottom' ? 'border-b-gray-800' : position === 'left' ? 'border-l-gray-800' : 'border-r-gray-800'}`}
        />
      </div>
    </div>
  );
};

