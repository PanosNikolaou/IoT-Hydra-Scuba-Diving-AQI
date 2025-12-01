// Custom plugin for gradient background
const backgroundPlugin = {
    id: 'customBackground',
    beforeDraw: (chart) => {
        const { ctx, chartArea } = chart;
        if (!chartArea) {
            // Skip if chartArea is not yet defined
            return;
        }
        ctx.save();
        // Create a vertical gradient background
        const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
        gradient.addColorStop(0, '#e0f7fa'); // Light blue
        gradient.addColorStop(1, '#ffffff'); // White

        // Draw the gradient background
        ctx.fillStyle = gradient;
        ctx.fillRect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
        ctx.restore();
    },
};

const ctx = document.getElementById('liveChart').getContext('2d');
const liveChart = new Chart(ctx, {
    type: 'line',
    data: {
        labels: [],
        datasets: [
            {
                label: 'Dust Density',
                data: [],
                borderColor: 'rgba(255, 99, 132, 1)',
                backgroundColor: 'rgba(255, 99, 132, 0.2)',
                fill: true,
            },
            {
                label: 'PM2.5',
                data: [],
                borderColor: 'rgba(54, 162, 235, 1)',
                backgroundColor: 'rgba(54, 162, 235, 0.2)',
                fill: true,
            },
            {
                label: 'PM10',
                data: [],
                borderColor: 'rgba(75, 192, 192, 1)',
                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                fill: true,
            },
        ],
    },
    options: {
        responsive: true,
        scales: {
            x: {
                type: 'time',
                time: {
                    unit: 'second',
                },
                title: {
                    display: true,
                    text: 'Time',
                },
            },
            y: {
                title: {
                    display: true,
                    text: 'Value',
                },
            },
        },
    },
    plugins: [backgroundPlugin], // Register the custom background plugin
});


const recordsPerPage = 10;
let currentPage = 1;
let activeFilter = '24hours'; // Default filter

document.getElementById('pm_timeFilter').addEventListener('change', (event) => {
    activeFilter = event.target.value;
    document.getElementById('customDateRange').style.display = activeFilter === 'custom' ? 'block' : 'none';
});

document.getElementById('applyFilter').addEventListener('click', () => {
    fetchDataAndUpdate(); // Re-fetch data with the selected filter
});

let pmData = []; // Global variable to store MQ sensor data


async function fetchDataAndUpdate() {
    try {
        const response = await fetch('/api/data');
        const result = await response.json();

        // Access the general sensor data
        pmData = result.general_data || [];
        //console.log('Fetched general data:', data);

        // Filter out records with null or 0 values
//        const filteredData = data.filter(record =>
//            record.dust !== null && record.dust !== 0 &&
//            record.pm2_5 !== null && record.pm2_5 !== 0 &&
//            record.pm10 !== null && record.pm10 !== 0
//        );

        const filteredData = filterDataByCriteria(pmData);

        //console.log('Filtered data:', filteredData);

        // Update the chart
        updatePMChart(filteredData);
        // Update the chart with the most recent 20 valid records
//        const recentData = filteredData.slice(-20);
//        const timestamps = recentData.map(record => new Date(record.timestamp));
//        const dust = recentData.map(record => record.dust);
//        const pm2_5 = recentData.map(record => record.pm2_5);
//        const pm10 = recentData.map(record => record.pm10);
//
//        liveChart.data.labels = timestamps;
//        liveChart.data.datasets[0].data = dust;
//        liveChart.data.datasets[1].data = pm2_5;
//        liveChart.data.datasets[2].data = pm10;
//        liveChart.update();

        // Render the table and pagination controls
        renderTablePage(filteredData);
        renderPagination(result.pages);
    } catch (error) {
        console.error('Error fetching data:', error);
    }
}

// Filter Data Based on User Selection
function filterDataByCriteria(data) {
    const now = new Date();
    let filteredData = data;

    if (activeFilter === '1hour') {
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        filteredData = data.filter(record => new Date(record.timestamp) >= oneHourAgo);
    } else if (activeFilter === '24hours') {
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        filteredData = data.filter(record => new Date(record.timestamp) >= oneDayAgo);
    } else if (activeFilter === '7days') {
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        filteredData = data.filter(record => new Date(record.timestamp) >= sevenDaysAgo);
    } else if (activeFilter === 'custom') {
        const startDate = new Date(document.getElementById('startDate').value);
        const endDate = new Date(document.getElementById('endDate').value);
        filteredData = data.filter(record => {
            const recordDate = new Date(record.timestamp);
            return recordDate >= startDate && recordDate <= endDate;
        });
    }

    return filteredData;
}

function updatePMChart(filteredPMData) {

    const maxDataPoints = parseInt(document.getElementById('pm_maxDataPoints').value, 10) || 50;
    const sortedData = filteredPMData.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const limitedData = sortedData.slice(0, maxDataPoints).reverse(); // Get the latest points in chronological order

    const timestamps = limitedData.map(record => new Date(record.timestamp));
    const dust = limitedData.map(record => record.dust);
    const pm2_5 = limitedData.map(record => record.pm2_5);
    const pm10 = limitedData.map(record => record.pm10);

    liveChart.data.labels = timestamps;
    liveChart.data.datasets[0].data = dust;
    liveChart.data.datasets[1].data = pm2_5;
    liveChart.data.datasets[2].data = pm10;
    liveChart.update();
}

document.getElementById('applyFilter').addEventListener('click', () => {
    const timeFilter = document.getElementById('pm_timeFilter').value;
    const maxDataPoints = parseInt(document.getElementById('pm_maxDataPoints').value, 10) || 50;
    let startDate = null;
    let endDate = new Date(); // Default to now

    if (timeFilter === 'custom') {
        startDate = new Date(document.getElementById('startDate').value);
        endDate = new Date(document.getElementById('endDate').value);
    } else if (timeFilter === '1hour') {
        startDate = new Date(endDate.getTime() - 60 * 60 * 1000);
    } else if (timeFilter === '24hours') {
        startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
    } else if (timeFilter === '7days') {
        startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    // Filter the global z variable
    const filteredData = pmData.filter(record => {
        const timestamp = new Date(record.timestamp);
        return (!startDate || timestamp >= startDate) && timestamp <= endDate;
    });

    // Limit the data to maxDataPoints
    const limitedData = filteredData.slice(-maxDataPoints);

    // Update the chart
    updatePMChart(limitedData);

    // Close the modal
    const modal = bootstrap.Modal.getInstance(document.getElementById('filterModal'));
    modal.hide();
});

// Reset filter logic
document.getElementById('resetFilter').addEventListener('click', () => {
    document.getElementById('pm_timeFilter').value = '24hours';
    document.getElementById('startDate').value = '';
    document.getElementById('endDate').value = '';
    document.getElementById('pm_maxDataPoints').value = 50;

    // Reload the latest 50 data points
    const latestData = pmData.slice(-50);
    updatePMChart(latestData);
});

function renderPagination(totalPages) {
    const paginationControls = document.getElementById('pagination-controls');
    paginationControls.innerHTML = '';

    const maxVisibleButtons = 10; // Limit the number of visible buttons
    const startPage = Math.max(1, currentPage - Math.floor(maxVisibleButtons / 2));
    const endPage = Math.min(totalPages, startPage + maxVisibleButtons - 1);

    // Add Previous Button
    if (currentPage > 1) {
        const prevButton = document.createElement('button');
        prevButton.innerText = 'Previous';
        prevButton.addEventListener('click', () => {
            currentPage--;
            fetchDataAndUpdate();
        });
        paginationControls.appendChild(prevButton);
    }

    // Add Page Buttons
    for (let i = startPage; i <= endPage; i++) {
        const button = document.createElement('button');
        button.innerText = i;
        button.classList.add('pagination-button');
        if (i === currentPage) {
            button.classList.add('active');
        }
        button.addEventListener('click', () => {
            currentPage = i;
            fetchDataAndUpdate();
        });
        paginationControls.appendChild(button);
    }

    // Add Next Button
    if (currentPage < totalPages) {
        const nextButton = document.createElement('button');
        nextButton.innerText = 'Next';
        nextButton.addEventListener('click', () => {
            currentPage++;
            fetchDataAndUpdate();
        });
        paginationControls.appendChild(nextButton);
    }
}

function renderTablePage(data) {
    const tableBody = document.getElementById('data-table-body');
    tableBody.innerHTML = '';

    data.forEach(record => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${new Date(record.timestamp).toLocaleString()}</td>
            <td>${record.dust}</td>
            <td>${record.pm2_5}</td>
            <td>${record.pm10}</td>
        `;
        row.addEventListener('click', () => {
            showDetails(record);
        });
        tableBody.appendChild(row);
    });
}

function showDetails(record) {
    document.getElementById('modal-timestamp').innerText = new Date(record.timestamp).toLocaleString();
    document.getElementById('modal-dust').innerText = record.dust;
    document.getElementById('modal-pm25').innerText = record.pm2_5;
    document.getElementById('modal-pm10').innerText = record.pm10;

    const modal = new bootstrap.Modal(document.getElementById('detailsModal'));
    modal.show();
}

let fetchInterval; // To store the interval reference
let isPaused = false; // State to track if the graph is paused

// Function to fetch and update the graph data
async function fetchAndUpdateGraph() {
    try {
        const response = await fetch('/api/data'); // Replace with your actual API endpoint
        const result = await response.json();

        // Process and filter data as needed
        const filteredData = filterDataByCriteria(result.general_data || []);

        // Update the chart
        updatePMChart(filteredData);
    } catch (error) {
        console.error('Error fetching data:', error);
    }
}

// Start fetching data at regular intervals
function startFetchingData(intervalTime = 1000) {
    fetchInterval = setInterval(fetchAndUpdateGraph, intervalTime);
}

// Stop fetching data
function stopFetchingData() {
    clearInterval(fetchInterval);
}

// Event listeners for Pause/Resume buttons
document.addEventListener('DOMContentLoaded', () => {
    const pauseButton = document.getElementById('pauseGraph');
    const resumeButton = document.getElementById('resumeGraph');

    pauseButton.addEventListener('click', () => {
        if (!isPaused) {
            stopFetchingData();
            isPaused = true;
            pauseButton.disabled = true;
            resumeButton.disabled = false;
            console.log('Graph updates paused.');
        }
    });

    resumeButton.addEventListener('click', () => {
        if (isPaused) {
            startFetchingData();
            isPaused = false;
            pauseButton.disabled = false;
            resumeButton.disabled = true;
            console.log('Graph updates resumed.');
        }
    });
});

// Initialize the graph updates
startFetchingData(); // Start fetching data on page load


// Initialize the page
fetchDataAndUpdate();
setInterval(fetchDataAndUpdate, 1000);

