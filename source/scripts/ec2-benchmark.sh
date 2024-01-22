#!/bin/bash

INSTANCE_TYPE="g5.2xlarge"

# aws ec2 describe-images \
#     --owners amazon \
#     --filters "Name=name,Values=Deep Learning Base OSS Nvidia Driver GPU AMI*" "Name=is-public,Values=true" "Name=state,Values=available" \
#     --query "Images[*].[ImageId,Name,Description]" \
#     --region us-east-1 \
#     --output json | jq -r 'sort_by(.[1] | capture(".* (?<date>[0-9]+)$").date | strptime("%Y%m%d") | mktime) | .[-1][0]'
AMI_ID="ami-0da2ab58cace8997d"

# aws ec2 describe-key-pairs --region us-east-1 --query 'KeyPairs[*].KeyName' --output text
KEY_NAME="us-east-1" # Replace with your key pair name


# vpc_id=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --region us-east-1 --query 'Vpcs[*].VpcId' --output text)
# aws ec2 describe-security-groups --filters Name=$(vpc_id),Values=vpc-4eb2f634 Name=group-name,Values=default --region us-east-1 --query 'SecurityGroups[*].GroupId' --output text
SECURITY_GROUP=<your-security-group-id>

# aws ec2 describe-subnets --filters Name=vpc-id,Values=vpc-4eb2f634 --region us-east-1 --query 'Subnets[*].SubnetId' --output text
SUBNET_ID=<your-subnet-id>
ITERATIONS=5
LAUNCH_TIMES=()

# Function to get the duration between start and end time
get_duration() {
    local start=\$1
    local end=\$2
    echo "$(( end - start ))"
}

# Function to launch and terminate instance
launch_instance() {
    # Launch the instance
    local instance_info=$(aws ec2 run-instances --image-id $AMI_ID --count 1 --instance-type $INSTANCE_TYPE --key-name $KEY_NAME --security-group-ids $SECURITY_GROUP --subnet-id $SUBNET_ID --region us-east-1)
    local instance_id=$(echo $instance_info | jq -r .Instances[0].InstanceId)
    echo "Launched instance $instance_id" >&2

    # Wait for the instance to become available
    aws ec2 wait instance-running --instance-ids $instance_id --region us-east-1

    # Check the system log (optional validation)
    # aws ec2 get-console-output --instance-id $instance_id | grep "some validation text"

    # return the instance id
    echo $instance_id
}

# Main loop for benchmarking
for (( i=0; i<$ITERATIONS; i++ )); do
    start_time=$(date +%s)
    instance_id=$(launch_instance)
    end_time=$(date +%s)
    echo "Debug: Start time for iteration $((i+1)) is $start_time" >&2
    echo "Debug: End time for iteration $((i+1)) is $end_time" >&2
    # duration=$(get_duration $start_time $end_time)
    duration=$(( end_time - start_time ))
    LAUNCH_TIMES+=($duration)
    echo "Launch time for iteration $((i+1)): ${LAUNCH_TIMES[$i]} seconds"

    # Terminate the instance
    echo "Terminated instance $instance_id"
    aws ec2 terminate-instances --instance-ids $instance_id --region us-east-1
    echo "Now waiting for instance $instance_id to terminate"
    aws ec2 wait instance-terminated --instance-ids $instance_id --region us-east-1
done

# Calculate average launch time
total_time=0
for time in "${LAUNCH_TIMES[@]}"; do
    total_time=$((total_time + time))
done
average_time=$(echo "scale=2; $total_time / $ITERATIONS" | bc)

echo "Average launch time: $average_time seconds"
